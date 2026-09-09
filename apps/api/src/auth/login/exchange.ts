import { AuthLoginRequestSchema } from '../../database/schemas/auth-login-requests.js'
import { CLEARED_LOGIN_FIELDS, LOGIN, LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure, loginFailure } from '../../errors/login.js'
import type { LoginDependencies, LoginTokens, ProviderRegistration } from '../../types/login.js'
import type { IssuedAccessJwt } from '../access-jwt/types.js'
import { createIdentitySession } from '../identity-session.js'
import { challenge, equalHash, opaqueHash } from './crypto.js'
import { parseExchange } from './input.js'
import {
  exchangeExpired,
  freshTime,
  loginTransaction,
  markLoginRequestFailed,
  requestExpired
} from './state.js'

type ExchangeCommitResult =
  { status: 'issued'; tokens: LoginTokens } | { status: 'rejected'; error: LoginFailure }

export async function exchangeLogin(deps: LoginDependencies, input: unknown): Promise<LoginTokens> {
  const body = parseExchange(input)
  let needsCleanupAfterRollback = false

  try {
    const committed = await deps.dataSource.transaction<ExchangeCommitResult>(
      'READ COMMITTED',
      async (manager) => {
        const requests = manager.getRepository(AuthLoginRequestSchema)

        // 1. 같은 code를 동시에 소비하지 못하도록 요청을 잠근 뒤 시각을 읽는다.
        const request = await requests.findOne({
          where: { id: body.requestId },
          lock: { mode: 'pessimistic_write' }
        })
        const checkedAt = await freshTime(manager)

        const hasRequest = request != null
        const isRequestTruthy = hasRequest && Boolean(request)
        const isConsumed = isRequestTruthy && request.status === 'consumed'
        const isFailed = isRequestTruthy && !isConsumed && request.status === 'failed'
        const isRequestInvalid = !hasRequest || !isRequestTruthy || isConsumed || isFailed
        if (isRequestInvalid) {
          throw new LoginFailure(LOGIN_ERRORS.EXCHANGE_INVALID)
        }

        // 전체 요청이 만료됐다면 proof 검사 전에 정리를 commit하고 거절한다.
        const isRequestExpired = requestExpired(request, checkedAt)
        if (isRequestExpired) {
          await markLoginRequestFailed(manager, request.id)
          return {
            status: 'rejected',
            error: new LoginFailure(LOGIN_ERRORS.EXCHANGE_INVALID)
          }
        }

        // 2. 교환 자격을 확인한다. 잘못된 proof는 유효한 요청을 변경하지 않는다.
        const isExchangeReady = request.status === 'exchange_ready'
        const hasSameClient = isExchangeReady && request.clientId === body.clientId
        const hasSameMethod = hasSameClient && request.method === LOGIN.method
        const hasValidChallenge =
          hasSameMethod && request.codeChallenge === challenge(body.codeVerifier)
        const hasValidCode =
          hasValidChallenge && equalHash(request.exchangeCodeHash, opaqueHash(body.code))
        const isExchangeInvalid =
          !isExchangeReady ||
          !hasSameClient ||
          !hasSameMethod ||
          !hasValidChallenge ||
          !hasValidCode
        if (isExchangeInvalid) {
          throw new LoginFailure(LOGIN_ERRORS.EXCHANGE_INVALID)
        }

        const isExchangeExpiredBeforeSession = exchangeExpired(request, checkedAt)
        if (isExchangeExpiredBeforeSession) {
          await markLoginRequestFailed(manager, request.id)
          return {
            status: 'rejected',
            error: new LoginFailure(LOGIN_ERRORS.EXCHANGE_INVALID)
          }
        }

        let registration: ProviderRegistration
        try {
          registration = deps.registry.resolve(request)
        } catch {
          await markLoginRequestFailed(manager, request.id)
          return {
            status: 'rejected',
            error: new LoginFailure(LOGIN_ERRORS.INTERNAL)
          }
        }

        // 3. 같은 transaction에서 회원을 연결하고 session·refresh를 생성한다.
        // exchange_ready의 DB CHECK가 verifiedSubject의 존재를 보장한다.
        const identitySession = await createIdentitySession(manager, {
          provider: registration.provider,
          subject: request.verifiedSubject!
        })

        // 회원의 잠금을 기다리는 동안 만료됐으면 방금 생성한 내용도 rollback한다.
        const checkedAfterSessionCreationAt = await freshTime(manager)
        const isExchangeExpiredAfterSession = exchangeExpired(
          request,
          checkedAfterSessionCreationAt
        )
        if (isExchangeExpiredAfterSession) {
          needsCleanupAfterRollback = true
          throw new LoginFailure(LOGIN_ERRORS.EXCHANGE_INVALID)
        }

        // 4. JWT를 준비한다. 서명 실패도 위 DB 쓰기 전체를 rollback한다.
        const issuedAt = identitySession.session.createdAt.getTime() / 1000
        const idleDeadline = issuedAt + LOGIN.idleSeconds
        let accessJwt: IssuedAccessJwt
        try {
          accessJwt = await deps.issueAccessJwt({
            userId: identitySession.user.id,
            sessionId: identitySession.session.id,
            issuedAt,
            idleDeadline
          })
        } catch {
          throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
        }

        // 5. 서명 중 만료되지 않았는지 확인하고 code 소비와 민감 정보 정리를 저장한다.
        const consumedAt = await freshTime(manager)
        const isExchangeExpiredBeforeConsumption = exchangeExpired(request, consumedAt)
        if (isExchangeExpiredBeforeConsumption) {
          needsCleanupAfterRollback = true
          throw new LoginFailure(LOGIN_ERRORS.EXCHANGE_INVALID)
        }

        await requests.update(
          { id: request.id },
          {
            ...CLEARED_LOGIN_FIELDS,
            status: 'consumed',
            consumedAt
          }
        )

        return {
          status: 'issued',
          tokens: {
            tokenType: 'Bearer',
            accessToken: accessJwt.accessToken,
            accessTokenExpiresAt: new Date(accessJwt.expiresAt * 1000).toISOString(),
            refreshToken: identitySession.refreshToken,
            sessionExpiresAt: new Date(idleDeadline * 1000).toISOString(),
            user: identitySession.user,
            isNewUser: identitySession.isNewUser
          }
        }
      }
    )

    // transaction의 commit·release가 확인된 뒤에만 거절 또는 token 응답을 전달한다.
    const isRejected = committed.status === 'rejected'
    if (isRejected) {
      throw committed.error
    }
    return committed.tokens
  } catch (error) {
    const failure = loginFailure(error, LOGIN_ERRORS.UNAVAILABLE)

    if (needsCleanupAfterRollback) {
      // 회원/session/refresh 생성의 rollback 뒤, 별도 transaction으로 만료 요청만 정리한다.
      await clearExpiredExchange(deps, body.requestId)
    }

    throw failure
  }
}

async function clearExpiredExchange(deps: LoginDependencies, id: string): Promise<void> {
  await loginTransaction(deps.dataSource, async (manager) => {
    const request = await manager.getRepository(AuthLoginRequestSchema).findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' }
    })
    const checkedAt = await freshTime(manager)

    // rollback 후 다른 요청이 상태를 바꿨을 수 있으므로 현재 상태·만료를 다시 확인한다.
    const isExchangeReady = request?.status === 'exchange_ready'
    const shouldClearExchange = isExchangeReady && exchangeExpired(request, checkedAt)
    if (shouldClearExchange) {
      await markLoginRequestFailed(manager, request.id)
    }
  })
}
