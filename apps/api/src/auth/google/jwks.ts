import { createLocalJWKSet, errors } from 'jose'
import type { JWK, JWSHeaderParameters, FlattenedJWSInput } from 'jose'
import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure, loginFailure } from '../../errors/login.js'
import { discardResponse, readProviderJson, withAbort } from './transport.js'

interface PublicKeys {
  resolver: ReturnType<typeof createLocalJWKSet>
  expiresAt: number
  generation: number
}

interface PublicKeyLoad {
  controller: AbortController
  promise: Promise<PublicKeys>
  waiters: number
  settled: boolean
}

function cacheLifetime(headers: Headers): number {
  const cacheControl = headers.get('cache-control') ?? ''
  const directives = cacheControl.toLowerCase().split(',').map((part) => part.trim())
  const prohibitsReuse = directives.some((part) => {
    const isNoCacheDirective = /^(no-store|no-cache)(?:=|$)/.test(part)
    return isNoCacheDirective
  })
  if (prohibitsReuse) return 0
  const maxAgeDirective = directives.find((part) => {
    const isMaxAgeDirective = /^max-age=\d+$/.test(part)
    return isMaxAgeDirective
  })
  const hasMaxAge = maxAgeDirective != null
  if (!hasMaxAge) return 0
  const maxAge = maxAgeDirective.slice(8)
  const age = headers.get('age') ?? '0'
  const isValidAge = /^\d+$/.test(age)
  if (!isValidAge) return 0
  const remaining = Number(maxAge) - Number(age)
  const isSafeLifetime = Number.isSafeInteger(remaining)
  const isPositiveLifetime = isSafeLifetime && remaining > 0
  const canReuse = isSafeLifetime && isPositiveLifetime
  return canReuse ? remaining * 1000 : 0
}

/** Shared state에는 public key만 둔다. 각 callback의 token/identity/signal은 load에 넣지 않는다. */
export function createGoogleJwks(jwksUri: string, fetchGoogle: typeof globalThis.fetch) {
  let cached: PublicKeys | undefined
  let currentLoad: PublicKeyLoad | undefined
  let lastStarted = 0
  let lastStored = 0

  async function fetchPublicKeys(generation: number, signal: AbortSignal): Promise<PublicKeys> {
    const isInitiallyAborted = signal.aborted
    if (isInitiallyAborted) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
    let response: Response | undefined
    let body: unknown
    try {
      let request: Promise<Response>
      try {
        request = fetchGoogle(jwksUri, {
          method: 'GET', redirect: 'error', cache: 'no-store', signal,
        }).catch(() => { throw new LoginFailure(LOGIN_ERRORS.PROVIDER) })
      } catch {
        throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
      }
      response = await withAbort(request, signal, discardResponse)
      // Body 대기를 cache 수명에 더하지 않는다.
      const expiresAt = Date.now() + cacheLifetime(response.headers)
      body = await readProviderJson(response, signal)
      const isAbortedAfterBody = signal.aborted
      if (isAbortedAfterBody) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)

      const jwksResponse = body
      const isResponseObject = jwksResponse != null && typeof jwksResponse === 'object'
      if (!isResponseObject) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
      const hasKeys = 'keys' in jwksResponse
      const candidates = hasKeys ? jwksResponse.keys : undefined
      const isKeysArray = Array.isArray(candidates)
      const isValidJwksBody = hasKeys && isKeysArray
      if (!isValidJwksBody) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
      const keys: JWK[] = candidates.map((key: unknown) => {
        const isKeyObject = key != null && typeof key === 'object'
        if (!isKeyObject) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
        // Parsing은 jose에 맡기고 public RSA field 이외의 응답 data는 보관하지 않는다.
        const publicKey: Record<string, unknown> = {}
        for (const field of ['kty', 'kid', 'alg', 'use', 'key_ops', 'n', 'e']) {
          const hasField = field in key
          if (hasField) publicKey[field] = key[field as keyof typeof key]
        }
        return publicKey as JWK
      })
      let resolver: ReturnType<typeof createLocalJWKSet>
      try {
        resolver = createLocalJWKSet({ keys })
      } catch {
        throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
      }
      const result = { resolver, expiresAt, generation }
      const isLatestResult = generation >= lastStored
      if (isLatestResult) {
        lastStored = generation
        const isFreshResult = expiresAt > Date.now()
        cached = isFreshResult ? result : undefined
      }
      return result
    } finally {
      const pendingResponse = response
      const hasResponse = pendingResponse != null
      if (hasResponse) discardResponse(pendingResponse)
      body = undefined
      response = undefined
    }
  }

  function startLoad(): PublicKeyLoad {
    const controller = new AbortController()
    const generation = ++lastStarted
    const promise = fetchPublicKeys(generation, controller.signal)
    const load = { controller, promise, waiters: 0, settled: false }
    const finish = () => {
      load.settled = true
      const isCurrentLoad = currentLoad === load
      if (isCurrentLoad) currentLoad = undefined
    }
    void promise.then(finish, finish)
    currentLoad = load
    return load
  }

  async function waitForLoad(signal: AbortSignal): Promise<PublicKeys> {
    const isInitiallyAborted = signal.aborted
    if (isInitiallyAborted) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
    const pending = currentLoad
    const hasPendingLoad = pending != null
    const load = hasPendingLoad ? pending : startLoad()
    load.waiters += 1
    try {
      // 각 callback은 원래 signal로만 기다리며 다른 waiter의 deadline을 연장하지 않는다.
      return await withAbort(load.promise, signal)
    } finally {
      load.waiters -= 1
      // 첫 이탈 뒤 신규 caller는 새 generation을 시작한다. Hung load의 연속 유입을 끊는다.
      const isCurrentLoad = currentLoad === load
      if (isCurrentLoad) currentLoad = undefined
      const hasNoWaiters = load.waiters === 0
      const isPending = !load.settled
      const shouldAbortFetch = hasNoWaiters && isPending
      if (shouldAbortFetch) load.controller.abort()
    }
  }

  return async (header: JWSHeaderParameters, token: FlattenedJWSInput, signal: AbortSignal) => {
    const isInitiallyAborted = signal.aborted
    if (isInitiallyAborted) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
    const initialCache = cached
    const hasCache = initialCache != null
    const isFreshCache = hasCache && Date.now() < initialCache.expiresAt
    const keys = isFreshCache ? initialCache : await waitForLoad(signal)
    try {
      return await withAbort(keys.resolver(header, token), signal)
    } catch (error) {
      const isUnknownKid = error instanceof errors.JWKSNoMatchingKey
      if (!isUnknownKid) throw loginFailure(error, LOGIN_ERRORS.PROVIDER)

      // 다른 waiter가 이미 새 generation을 받았다면 같은 unknown kid refresh를 반복하지 않는다.
      const latestCache = cached
      const hasLatestCache = latestCache != null
      const isNewerGeneration = hasLatestCache && latestCache.generation > keys.generation
      const isFreshGeneration = isNewerGeneration && Date.now() < latestCache.expiresAt
      const canUseRefreshedCache = hasLatestCache && isNewerGeneration && isFreshGeneration
      const refreshed = canUseRefreshedCache ? latestCache : await waitForLoad(signal)
      try {
        // Cold/expired key miss도 이 한 번의 refresh 뒤에는 추가 fetch 없이 실패한다.
        return await withAbort(refreshed.resolver(header, token), signal)
      } catch (error) {
        throw loginFailure(error, LOGIN_ERRORS.PROVIDER)
      }
    }
  }
}
