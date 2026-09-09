import { performance } from 'node:perf_hooks'
import { AuthLoginRequestSchema } from '../../database/schemas/auth-login-requests.js'
import { CLEARED_LOGIN_FIELDS, LOGIN, LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure, loginFailure } from '../../errors/login.js'
import type { AuthProvider, VerifiedIdentity } from '../../types/auth.js'
import type {
  ClaimedLogin,
  CompletedLoginCallback,
  LoginCallbackInput,
  LoginDependencies,
  ProviderRegistration
} from '../../types/login.js'
import { newOpaque, opaqueHash } from './crypto.js'
import { parseCallback } from './input.js'
import {
  browserCookie,
  cookieMatches,
  freshTime,
  loginTransaction,
  markLoginRequestFailed,
  requestExpired
} from './state.js'

interface ClaimedProviderLogin extends ClaimedLogin {
  providerCode: string
}

interface VerifiedProviderLogin {
  identity: VerifiedIdentity
  completedAt: Date
}

type CallbackClaimResult =
  { status: 'claimed'; claim: ClaimedProviderLogin } | { status: 'rejected'; error: LoginFailure }

type CallbackCommitResult =
  | { status: 'completed'; completion: CompletedLoginCallback }
  | { status: 'rejected'; error: LoginFailure }

export async function completeLoginCallback(
  deps: LoginDependencies,
  provider: AuthProvider,
  query: URLSearchParams,
  cookieHeader: string
): Promise<CompletedLoginCallback> {
  const input = parseCallback(query)

  // 1. Callback을 한 번만 선점하고 짧은 transaction을 끝낸다.
  const claimed = await claimCallback(deps, provider, input, cookieHeader)

  // 2. DB 잠금을 놓은 상태에서 provider를 검증한다. 이 단계의 실패만 claim을 정리한다.
  let verified: VerifiedProviderLogin
  try {
    verified = await verifyProviderLogin(deps, claimed)
  } catch (error) {
    await failClaim(deps, claimed.row.id)
    throw error
  }

  // 3. 다시 요청을 잠그고 검증 결과와 일회용 exchange code를 함께 저장한다.
  return prepareExchangeCode(deps, claimed, verified)
}

async function claimCallback(
  deps: LoginDependencies,
  provider: AuthProvider,
  input: LoginCallbackInput,
  cookieHeader: string
): Promise<ClaimedProviderLogin> {
  try {
    const committed = await deps.dataSource.transaction<CallbackClaimResult>(
      'READ COMMITTED',
      async (manager) => {
        const requests = manager.getRepository(AuthLoginRequestSchema)
        const request = await requests.findOne({
          where: { stateHash: opaqueHash(input.state) },
          lock: { mode: 'pessimistic_write' }
        })
        const checkedAt = await freshTime(manager)

        const hasRequest = request != null
        const isRequestTruthy = hasRequest && Boolean(request)
        const hasSameProvider = isRequestTruthy && request.provider === provider
        const hasCookieBinding = hasSameProvider && cookieMatches(request, cookieHeader)
        const isRequestInvalid = !hasRequest || !hasSameProvider || !hasCookieBinding
        if (isRequestInvalid) {
          throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
        }
        // Binding이 맞는 만료 요청은 processing 상태여도 정리를 commit한다.
        const isRequestExpired = requestExpired(request, checkedAt)
        if (isRequestExpired) {
          await markLoginRequestFailed(manager, request.id)
          return { status: 'rejected', error: new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID) }
        }
        const hasBrowserStarted = request.status === 'browser_started'
        if (!hasBrowserStarted) {
          throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
        }

        let registration: ProviderRegistration
        try {
          registration = deps.registry.resolve(request)
        } catch {
          await markLoginRequestFailed(manager, request.id)
          return { status: 'rejected', error: new LoginFailure(LOGIN_ERRORS.INTERNAL) }
        }

        const hasProviderError = input.error !== undefined
        if (hasProviderError) {
          await markLoginRequestFailed(manager, request.id)
          const isAccessDenied = input.error === 'access_denied'
          const failure = isAccessDenied ? LOGIN_ERRORS.CANCELLED : LOGIN_ERRORS.PROVIDER
          return { status: 'rejected', error: new LoginFailure(failure) }
        }

        let providerVerifier: string
        try {
          providerVerifier = deps.pkceKeys.decrypt(request)
        } catch {
          await markLoginRequestFailed(manager, request.id)
          return { status: 'rejected', error: new LoginFailure(LOGIN_ERRORS.INTERNAL) }
        }

        await requests.update({ id: request.id }, { status: 'processing' })
        return {
          status: 'claimed',
          claim: {
            row: request,
            snapshot: registration,
            providerVerifier,
            // Commit·release 지연도 provider의 단일 deadline에 포함한다.
            startedAt: performance.now(),
            // Error callback은 위에서 정리했으므로 code가 있는 입력만 남는다.
            providerCode: input.code
          }
        }
      }
    )

    const isRejected = committed.status === 'rejected'
    if (isRejected) {
      throw committed.error
    }
    return committed.claim
  } catch (error) {
    throw loginFailure(error, LOGIN_ERRORS.UNAVAILABLE)
  }
}

async function failClaim(deps: LoginDependencies, requestId: string): Promise<void> {
  await loginTransaction(deps.dataSource, async (manager) => {
    const request = await manager.getRepository(AuthLoginRequestSchema).findOne({
      where: { id: requestId },
      lock: { mode: 'pessimistic_write' }
    })
    const isProcessing = request?.status === 'processing'
    if (isProcessing) {
      await markLoginRequestFailed(manager, request.id)
    }
  })
}

async function verifyProviderLogin(
  deps: LoginDependencies,
  claimed: ClaimedProviderLogin
): Promise<VerifiedProviderLogin> {
  const controller = new AbortController()
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = claimed.startedAt + LOGIN.providerDeadlineMs

  try {
    const remainingMs = deadline - performance.now()
    const isDeadlineElapsed = remainingMs <= 0
    if (isDeadlineElapsed) {
      throw new Error()
    }

    // Provider 호출과 timeout은 같은 deadline을 공유하며 retry하지 않는다.
    const verification = Promise.resolve().then(() =>
      deps.verifyProvider({
        snapshot: claimed.snapshot,
        code: claimed.providerCode,
        providerVerifier: claimed.providerVerifier,
        nonceHash: claimed.row.oidcNonceHash,
        signal: controller.signal
      })
    )
    const timeout = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        controller.abort()
        reject(new Error())
      }, remainingMs)
    })
    const identity = await Promise.race([verification, timeout])

    // Timer가 아직 실행되지 않았어도 deadline을 지난 결과는 수용하지 않는다.
    const isVerificationExpired = performance.now() >= deadline
    const hasSameProvider =
      !isVerificationExpired && identity?.provider === claimed.snapshot.provider
    const isSubjectString = hasSameProvider && typeof identity.subject === 'string'
    const isSubjectEmpty = isSubjectString && identity.subject.length === 0
    const isIdentityInvalid =
      isVerificationExpired || !hasSameProvider || !isSubjectString || isSubjectEmpty
    if (isIdentityInvalid) {
      throw new Error()
    }

    // 완료 transaction의 DB 잠금 대기가 code TTL을 연장하지 않도록 먼저 시각을 고정한다.
    return {
      identity: { provider: identity.provider, subject: identity.subject },
      completedAt: new Date(Math.floor(Date.now() / 1000) * 1000)
    }
  } catch {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  } finally {
    clearTimeout(deadlineTimer)
    controller.abort()
    claimed.providerVerifier = ''
    claimed.providerCode = ''
  }
}

async function prepareExchangeCode(
  deps: LoginDependencies,
  claimed: ClaimedProviderLogin,
  verified: VerifiedProviderLogin
): Promise<CompletedLoginCallback> {
  try {
    const committed = await deps.dataSource.transaction<CallbackCommitResult>(
      'READ COMMITTED',
      async (manager) => {
        const requests = manager.getRepository(AuthLoginRequestSchema)
        const request = await requests.findOne({
          where: { id: claimed.row.id },
          lock: { mode: 'pessimistic_write' }
        })
        const checkedAt = await freshTime(manager)

        // 외부 검증 중 상태 또는 등록 binding이 달라진 요청은 완료하지 않는다.
        const hasRequest = request != null
        const isRequestTruthy = hasRequest && Boolean(request)
        const isProcessing = isRequestTruthy && request.status === 'processing'
        const hasSameProvider = isProcessing && request.provider === claimed.snapshot.provider
        const hasSameVersion =
          hasSameProvider && request.providerConfigVersion === claimed.snapshot.version
        const hasSameReturnTarget =
          hasSameVersion && request.returnTargetId === claimed.snapshot.returnTarget.id
        const isRequestInvalid =
          !hasRequest ||
          !isProcessing ||
          !hasSameProvider ||
          !hasSameVersion ||
          !hasSameReturnTarget
        if (isRequestInvalid) {
          throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
        }

        const codeDeadline = verified.completedAt.getTime() + LOGIN.codeSeconds * 1000
        const codeExpiresAt = new Date(Math.min(codeDeadline, request.expiresAt.getTime()))
        const isRequestExpired = requestExpired(request, checkedAt)
        const isCodeExpired = !isRequestExpired && checkedAt.getTime() >= codeExpiresAt.getTime()
        const isExchangeExpired = isRequestExpired || isCodeExpired
        if (isExchangeExpired) {
          await markLoginRequestFailed(manager, request.id)
          return { status: 'rejected', error: new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID) }
        }

        const code = newOpaque()
        await requests.update(
          { id: request.id },
          {
            ...CLEARED_LOGIN_FIELDS,
            status: 'exchange_ready',
            codeChallenge: request.codeChallenge,
            method: request.method,
            verifiedSubject: verified.identity.subject,
            exchangeCodeHash: opaqueHash(code),
            codeExpiresAt
          }
        )

        return {
          status: 'completed',
          completion: {
            returnUrl: `${claimed.snapshot.returnTarget.url}?code=${code}`,
            cookie: browserCookie({ requestId: request.id, bindingValue: '', maxAgeSeconds: 0 })
          }
        }
      }
    )

    // 정리 또는 exchange-ready 저장의 commit·release 뒤에만 HTTP 결과를 전달한다.
    const isRejected = committed.status === 'rejected'
    if (isRejected) {
      throw committed.error
    }
    return committed.completion
  } catch (error) {
    throw loginFailure(error, LOGIN_ERRORS.UNAVAILABLE)
  }
}
