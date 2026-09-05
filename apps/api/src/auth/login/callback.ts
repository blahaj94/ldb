import { performance } from 'node:perf_hooks'
import { AuthLoginRequestSchema } from '../../database/schemas/auth-login-requests.js'
import { CLEARED_LOGIN_FIELDS, LOGIN, LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { AuthProvider, VerifiedIdentity } from '../../types/auth.js'
import type { ClaimedLogin, LoginDependencies } from '../../types/login.js'
import { newOpaque, opaqueHash } from './crypto.js'
import { parseCallback } from './input.js'
import { browserCookie, cookieMatches, freshTime, loginTransaction, requestExpired, resolveRegistration, terminal } from './state.js'

async function claimCallback(deps: LoginDependencies, provider: AuthProvider, query: URLSearchParams, cookie: string): Promise<ClaimedLogin> {
  const input = parseCallback(query)
  return loginTransaction(deps.dataSource, async (manager) => {
    const requests = manager.getRepository(AuthLoginRequestSchema)
    const row = await requests.findOne({ where: { stateHash: opaqueHash(input.state) }, lock: { mode: 'pessimistic_write' } })
    const time = await freshTime(manager)
    if (!row || row.status !== 'browser_started' || row.provider !== provider || !cookieMatches(row, cookie)) {
      throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
    }
    if (requestExpired(row, time)) {
      await terminal(manager, row)
      return new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
    }
    const snapshot = await resolveRegistration(manager, row, deps.registry)
    if (snapshot instanceof LoginFailure) return snapshot
    if (input.error !== undefined) {
      await terminal(manager, row)
      return new LoginFailure(input.error === 'access_denied' ? LOGIN_ERRORS.CANCELLED : LOGIN_ERRORS.PROVIDER)
    }
    let providerVerifier: string
    try { providerVerifier = deps.pkceKeys.decrypt(row) } catch {
      await terminal(manager, row)
      return new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
    await requests.update({ id: row.id }, { status: 'processing' })
    // Commit 지연도 provider의 단일 deadline에 포함한다.
    return { row, snapshot, providerVerifier, startedAt: performance.now() }
  })
}

async function failClaim(deps: LoginDependencies, id: string): Promise<void> {
  await loginTransaction(deps.dataSource, async (manager) => {
    const row = await manager.getRepository(AuthLoginRequestSchema).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } })
    if (row?.status === 'processing') await terminal(manager, row)
  })
}

async function verify(deps: LoginDependencies, claimed: ClaimedLogin, code: string): Promise<{ identity: VerifiedIdentity; completedAt: Date }> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = claimed.startedAt + LOGIN.providerDeadlineMs
  try {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error()
    const identity = await Promise.race([
      Promise.resolve().then(() => deps.verifyProvider({
        snapshot: claimed.snapshot, code, providerVerifier: claimed.providerVerifier,
        nonceHash: claimed.row.oidcNonceHash, signal: controller.signal,
      })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error()) }, remaining)
      }),
    ])
    if (performance.now() >= deadline || identity?.provider !== claimed.snapshot.provider ||
      typeof identity.subject !== 'string' || identity.subject.length === 0) throw new Error()
    // DB lock 대기가 검증 완료 시점의 60초 TTL을 연장하지 않도록 먼저 고정한다.
    return { identity: { provider: identity.provider, subject: identity.subject }, completedAt: new Date(Math.floor(Date.now() / 1000) * 1000) }
  } catch { throw new LoginFailure(LOGIN_ERRORS.PROVIDER) } finally {
    clearTimeout(timer)
    controller.abort()
    claimed.providerVerifier = ''
  }
}

export async function completeLoginCallback(deps: LoginDependencies, provider: AuthProvider, query: URLSearchParams, cookieHeader: string) {
  const input = parseCallback(query)
  const claimed = await claimCallback(deps, provider, query, cookieHeader)
  let verified: Awaited<ReturnType<typeof verify>>
  try { verified = await verify(deps, claimed, input.code!) } catch (error) {
    await failClaim(deps, claimed.row.id)
    throw error
  }
  return loginTransaction(deps.dataSource, async (manager) => {
    const requests = manager.getRepository(AuthLoginRequestSchema)
    const row = await requests.findOne({ where: { id: claimed.row.id }, lock: { mode: 'pessimistic_write' } })
    const time = await freshTime(manager)
    if (!row || row.status !== 'processing' || row.provider !== claimed.snapshot.provider ||
      row.providerConfigVersion !== claimed.snapshot.version || row.returnTargetId !== claimed.snapshot.returnTarget.id) {
      throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
    }
    const codeExpiresAt = new Date(Math.min(verified.completedAt.getTime() + LOGIN.codeSeconds * 1000, row.expiresAt.getTime()))
    if (requestExpired(row, time) || time.getTime() >= codeExpiresAt.getTime()) {
      await terminal(manager, row)
      return new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
    }
    const code = newOpaque()
    await requests.update({ id: row.id }, {
      ...CLEARED_LOGIN_FIELDS, status: 'exchange_ready', codeChallenge: row.codeChallenge, method: row.method,
      verifiedSubject: verified.identity.subject, exchangeCodeHash: opaqueHash(code), codeExpiresAt,
    })
    return {
      returnUrl: `${claimed.snapshot.returnTarget.url}?code=${code}`,
      cookie: browserCookie(row.id, '', 0),
    }
  })
}
