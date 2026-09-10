import { randomUUID } from 'node:crypto'
import { AuthLoginRequestSchema } from '../../database/schemas/auth-login-requests.js'
import { CLEARED_LOGIN_FIELDS, LOGIN, LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure, loginFailure } from '../../errors/login.js'
import type { AuthProvider } from '../../types/auth.js'
import type {
  CreatedLoginRequest,
  LoginAuthorization,
  LoginDependencies,
  ProviderRegistration
} from '../../types/login.js'
import { challenge, decodeOpaque, newOpaque, opaqueHash } from './crypto.js'
import { parseCreation } from './input.js'
import {
  browserCookie,
  freshTime,
  loginTransaction,
  markLoginRequestFailed,
  requestExpired
} from './state.js'

type AuthorizationCommitResult =
  | { status: 'authorized'; authorization: LoginAuthorization }
  | { status: 'rejected'; error: LoginFailure }

function authorizationScope(provider: AuthProvider): string {
  const isGoogleProvider = provider === 'google'
  return isGoogleProvider ? 'openid profile' : 'identify'
}

function createProviderNonce(provider: AuthProvider): string | null {
  const isGoogleProvider = provider === 'google'
  if (!isGoogleProvider) {
    return null
  }
  const nonce = newOpaque()
  const hasNonce = nonce != null
  if (!hasNonce) {
    return null
  }
  const hasTruthyNonce = Boolean(nonce)
  if (!hasTruthyNonce) {
    return null
  }
  return nonce
}

export async function createLoginRequest(
  deps: LoginDependencies,
  input: unknown
): Promise<CreatedLoginRequest> {
  const body = parseCreation(input)
  const registration = deps.registry.active(body.provider)

  return loginTransaction(deps.dataSource, async (manager) => {
    const createdAt = await freshTime(manager)
    const expiresAt = new Date(createdAt.getTime() + LOGIN.requestSeconds * 1000)
    const ticket = newOpaque()
    let requestId: string
    try {
      requestId = randomUUID()
    } catch {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }

    // 회원/session 생성 전의 요청만 저장한다. 등록 version과 앱 proof를 이 요청에 고정한다.
    await manager.getRepository(AuthLoginRequestSchema).insert({
      ...CLEARED_LOGIN_FIELDS,
      id: requestId,
      purpose: LOGIN.purpose,
      provider: body.provider,
      clientId: LOGIN.clientId,
      providerConfigVersion: registration.version,
      returnTargetId: registration.returnTarget.id,
      createdAt,
      expiresAt,
      status: 'created',
      codeChallenge: body.codeChallenge,
      method: LOGIN.method,
      launchTicketHash: opaqueHash(ticket),
      consumedAt: null
    })

    return {
      requestId,
      browserUrl: `${deps.registry.apiOrigin}/auth/login/authorize?ticket=${ticket}`,
      expiresAt: expiresAt.toISOString()
    }
  })
}

export async function authorizeLogin(
  deps: LoginDependencies,
  ticket: string
): Promise<LoginAuthorization> {
  try {
    decodeOpaque(ticket)
  } catch {
    throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
  }

  try {
    const committed = await deps.dataSource.transaction<AuthorizationCommitResult>(
      'READ COMMITTED',
      async (manager) => {
        const requests = manager.getRepository(AuthLoginRequestSchema)

        // 1. Ticket의 요청을 잠그고 아직 browser를 시작하지 않은 요청인지 확인한다.
        const request = await requests.findOne({
          where: { launchTicketHash: opaqueHash(ticket) },
          lock: { mode: 'pessimistic_write' }
        })
        const checkedAt = await freshTime(manager)
        const hasRequest = request != null
        if (!hasRequest) {
          throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
        }
        const isRequestTruthy = Boolean(request)
        if (!isRequestTruthy) {
          throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
        }
        const isCreated = request.status === 'created'
        if (!isCreated) {
          throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
        }

        const isRequestExpired = requestExpired(request, checkedAt)
        if (isRequestExpired) {
          await markLoginRequestFailed(manager, request.id)
          return {
            status: 'rejected',
            error: new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
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

        // 2. Browser·provider proof는 앱 proof와 별개인 새 random 값으로 만든다.
        const state = newOpaque()
        const browserBinding = newOpaque()
        const providerVerifier = newOpaque()
        const nonce = createProviderNonce(request.provider)
        const hasNonce = nonce != null

        // Ticket 소비와 browser_started 전이를 함께 저장한다.
        await requests.update(
          { id: request.id },
          {
            status: 'browser_started',
            launchTicketHash: null,
            stateHash: opaqueHash(state),
            browserBindingHash: opaqueHash(browserBinding),
            oidcNonceHash: hasNonce ? opaqueHash(nonce) : null,
            ...deps.pkceKeys.encrypt(providerVerifier, request)
          }
        )

        // 3. 요청에 저장된 등록값으로 provider URL과 이 요청 전용 cookie를 준비한다.
        const authorizationUrl = new URL(registration.authorizationEndpoint)
        authorizationUrl.search = new URLSearchParams({
          response_type: 'code',
          client_id: registration.providerClientId,
          redirect_uri: registration.callbackUrl,
          scope: authorizationScope(request.provider),
          state,
          code_challenge: challenge(providerVerifier),
          code_challenge_method: LOGIN.method,
          ...(hasNonce ? { nonce } : {})
        }).toString()
        const remainingRequestSeconds = (request.expiresAt.getTime() - checkedAt.getTime()) / 1000
        const cookieSeconds = Math.min(LOGIN.requestSeconds, remainingRequestSeconds)

        return {
          status: 'authorized',
          authorization: {
            redirectUrl: authorizationUrl.href,
            cookie: browserCookie({
              requestId: request.id,
              bindingValue: browserBinding,
              maxAgeSeconds: cookieSeconds
            })
          }
        }
      }
    )

    // 만료·등록 오류의 정리도 commit·release가 확인된 뒤 거절 결과를 전달한다.
    const isRejected = committed.status === 'rejected'
    if (isRejected) {
      throw committed.error
    }
    return committed.authorization
  } catch (error) {
    throw loginFailure(error, LOGIN_ERRORS.UNAVAILABLE)
  }
}
