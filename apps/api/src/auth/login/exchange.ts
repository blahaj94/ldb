import { AuthLoginRequestSchema } from '../../database/schemas/auth-login-requests.js'
import { LOGIN, LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { LoginDependencies, LoginTokens } from '../../types/login.js'
import { createIdentitySession } from '../identity-session.js'
import { challenge, equalHash, opaqueHash } from './crypto.js'
import { parseExchange } from './input.js'
import { exchangeExpired, freshTime, loginTransaction, resolveRegistration, terminal } from './state.js'

async function clearExpiredExchange(deps: LoginDependencies, id: string): Promise<void> {
  await loginTransaction(deps.dataSource, async (manager) => {
    const row = await manager.getRepository(AuthLoginRequestSchema).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } })
    const time = await freshTime(manager)
    if (row?.status === 'exchange_ready' && exchangeExpired(row, time)) await terminal(manager, row)
  })
}

export async function exchangeLogin(deps: LoginDependencies, input: unknown): Promise<LoginTokens> {
  const body = parseExchange(input)
  let expiredAfterWrites = false
  try {
    return await loginTransaction(deps.dataSource, async (manager) => {
      const requests = manager.getRepository(AuthLoginRequestSchema)
      // 자신의 OAuth row를 먼저 잠그고 identity-session 내부의 user→session→refresh로 간다.
      const row = await requests.findOne({ where: { id: body.requestId }, lock: { mode: 'pessimistic_write' } })
      const time = await freshTime(manager)
      if (!row || row.status !== 'exchange_ready' || row.clientId !== body.clientId || row.method !== LOGIN.method ||
        row.codeChallenge !== challenge(body.codeVerifier) || !equalHash(row.exchangeCodeHash, opaqueHash(body.code))) {
        throw new LoginFailure(LOGIN_ERRORS.EXCHANGE_INVALID)
      }
      if (exchangeExpired(row, time)) {
        await terminal(manager, row)
        return new LoginFailure(LOGIN_ERRORS.EXCHANGE_INVALID)
      }
      const snapshot = await resolveRegistration(manager, row, deps.registry)
      if (snapshot instanceof LoginFailure) return snapshot
      const result = await createIdentitySession(manager, { provider: snapshot.provider, subject: row.verifiedSubject! })
      // User/identity UNIQUE 잠금 대기는 OAuth lock 이후에도 일어날 수 있다.
      if (exchangeExpired(row, await freshTime(manager))) {
        expiredAfterWrites = true
        throw new LoginFailure(LOGIN_ERRORS.EXCHANGE_INVALID)
      }
      const issuedAt = result.session.createdAt.getTime() / 1000
      const idleDeadline = issuedAt + LOGIN.idleSeconds
      let access
      try {
        access = await deps.issueAccessJwt({ userId: result.user.id, sessionId: result.session.id, issuedAt, idleDeadline })
      } catch { throw new LoginFailure(LOGIN_ERRORS.INTERNAL) }
      const consumedAt = await freshTime(manager)
      if (exchangeExpired(row, consumedAt)) {
        expiredAfterWrites = true
        throw new LoginFailure(LOGIN_ERRORS.EXCHANGE_INVALID)
      }
      await terminal(manager, row, consumedAt)
      return {
        tokenType: 'Bearer' as const, accessToken: access.accessToken,
        accessTokenExpiresAt: new Date(access.expiresAt * 1000).toISOString(),
        refreshToken: result.refreshToken, sessionExpiresAt: new Date(idleDeadline * 1000).toISOString(),
        user: result.user, isNewUser: result.isNewUser,
      }
    })
  } catch (error) {
    // 자격 재검증 실패로 이미 준비한 회원/session을 rollback한 뒤 만료 row만 정리한다.
    if (expiredAfterWrites) await clearExpiredExchange(deps, body.requestId)
    throw error
  }
}
