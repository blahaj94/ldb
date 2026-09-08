import { readBearerToken } from '../auth/bearer.js'
import type { AccessJwtPrincipal } from '../auth/access-jwt/types.js'
import { NeopleSearchFailure, neopleSearchFailure } from '../errors/neople-search.js'
import { createNeopleCharacterSearch } from './neople-character-search.js'
import { parseCharacterSearchQuery } from './query.js'
import { SearchAdmission, searchClock } from './search-admission.js'
import { recordSearchActivity } from './search-activity.js'
import { SearchDeadline } from './search-deadline.js'
import type { AuthenticatedSearchDependencies, AuthenticatedSearchHttpService } from './types.js'

export function createAuthenticatedSearchService(
  dependencies: AuthenticatedSearchDependencies
): AuthenticatedSearchHttpService {
  const deps = Object.freeze({ ...dependencies })
  const clock = deps.clock ?? searchClock
  const admission = new SearchAdmission(clock)
  const adapter = deps.searchCharacters ?? createNeopleCharacterSearch(deps.apiKey)
  const active = new Set<SearchDeadline>()
  const activities = new Set<Promise<void>>()
  let closed = false

  return {
    async search(rawHeaders, originalUrl, requestSignal) {
      const token = readBearerToken(rawHeaders)
      const hasToken = token != null
      if (!hasToken) {
        throw neopleSearchFailure('authentication')
      }
      let principal: AccessJwtPrincipal
      try {
        principal = await deps.verifyAccessJwt(token, Math.floor(Date.now() / 1000))
      } catch {
        throw neopleSearchFailure('authentication')
      }
      const input = parseCharacterSearchQuery(originalUrl)
      const isKeyString = typeof deps.apiKey === 'string'
      const hasKey = isKeyString && deps.apiKey.length > 0
      const cannotStart = !hasKey || closed
      if (cannotStart) {
        throw neopleSearchFailure('internal')
      }

      const deadline = new SearchDeadline(clock, requestSignal)
      active.add(deadline)
      let lease: Awaited<ReturnType<SearchAdmission['acquire']>> | undefined
      const finishAdmission = (): void => {
        lease?.release()
        deadline.dispose()
        active.delete(deadline)
      }
      try {
        lease = await deadline.wait(admission.acquire(principal.userId, deadline.signal))
        lease.assertCapacity()
        const activity = recordSearchActivity(deps, principal, deadline)
        activities.add(activity)
        void activity.then(
          () => activities.delete(activity),
          () => activities.delete(activity)
        )
        await deadline.wait(activity)

        // 마지막 await는 활동 commit/연결 종료다. 예약과 기존 adapter 시작 사이에 await를 두지 않는다.
        deadline.check()
        lease.reserve()
        const result = adapter(input)
        finishAdmission()
        return await result
      } catch (error) {
        const isSearchFailure = error instanceof NeopleSearchFailure
        if (isSearchFailure) {
          throw error
        }
        throw neopleSearchFailure('internal')
      } finally {
        finishAdmission()
      }
    },
    async onModuleDestroy() {
      closed = true
      for (const deadline of active) {
        deadline.abort()
      }
      admission.close()
      await Promise.allSettled(activities)
    }
  }
}
