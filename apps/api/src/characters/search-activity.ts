import type { AccessJwtPrincipal } from '../auth/access-jwt/types.js'
import { LOGIN } from '../constants/login.js'
import { AuthSessionSchema } from '../database/schemas/auth-sessions.js'
import { neopleSearchFailure } from '../errors/neople-search.js'
import type { SearchDeadline } from './search-deadline.js'
import { createSearchQueryRunner } from './search-query-runner.js'
import type { AuthenticatedSearchDependencies } from './types.js'

export async function recordSearchActivity(
  deps: AuthenticatedSearchDependencies,
  principal: AccessJwtPrincipal,
  deadline: SearchDeadline,
): Promise<void> {
  const createRunner = deps.createQueryRunner ?? createSearchQueryRunner
  const runner = createRunner(deps.dataSource, deadline.signal)
  try {
    await runner.connect()
    deadline.check()
    await runner.startTransaction('READ COMMITTED')
    deadline.check()
    const repository = runner.manager.getRepository(AuthSessionSchema)
    const session = await repository.findOne({
      where: { id: principal.sessionId, userId: principal.userId },
      lock: { mode: 'pessimistic_write' },
    })
    deadline.check()

    // Row가 없을 때도 조회가 끝난 뒤 fresh T로 JWT를 확인한다. User lock이나 복원은 없다.
    const [clock] = await runner.manager.query(
      'SELECT to_timestamp(floor(extract(epoch from clock_timestamp()))) AS now',
    ) as Array<{ now: Date }>
    deadline.check()
    const checkedAt = clock.now
    const checkedAtSeconds = checkedAt.getTime() / 1000
    const isJwtNotYetIssued = principal.issuedAt > checkedAtSeconds
    const isJwtExpired = checkedAtSeconds >= principal.expiresAt
    const isJwtInvalid = isJwtNotYetIssued || isJwtExpired
    if (isJwtInvalid) throw neopleSearchFailure('authentication')

    const hasSession = session != null
    const isRevoked = hasSession && session.revokedAt != null
    const canRecordActivity = hasSession && !isRevoked
    if (canRecordActivity) {
      const idleDeadline = session.lastActiveAt.getTime() / 1000 + LOGIN.idleSeconds
      const isIdleExpired = checkedAtSeconds >= idleDeadline
      if (isIdleExpired) throw neopleSearchFailure('authentication')
      const lastActiveAt = new Date(Math.max(session.lastActiveAt.getTime(), checkedAt.getTime()))
      await repository.update({ id: session.id }, { lastActiveAt })
      deadline.check()
    }
    await runner.commitTransaction()
    deadline.check()
  } catch (error) {
    const canRollback = runner.isTransactionActive && !deadline.signal.aborted
    if (canRollback) await runner.rollbackTransaction()
    // Commit acknowledgement 불명은 실패로 남긴다. 활동 rollback 성공을 추정하지 않는다.
    throw error
  } finally {
    await runner.release()
  }
}
