import type { ProviderVerificationInput } from '../../types/login.js'
import type { GoogleProviderConfiguration, GoogleProviderRegistration } from './types.js'
import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'

export function discardResponse(response: Response): void {
  // 이미 읽기 중인 native stream은 fetch의 같은 signal로 취소된다.
  const body = response.body
  const hasBody = body != null
  if (hasBody) void body.cancel().catch(() => undefined)
}

/** Callback의 단일 signal만 사용한다. 신호를 무시하는 외부 구현의 늦은 결과도 버린다. */
export function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  discard?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false
    const aborted = () => {
      finished = true
      signal.removeEventListener('abort', aborted)
      reject(new LoginFailure(LOGIN_ERRORS.PROVIDER))
    }
    signal.addEventListener('abort', aborted, { once: true })
    const isAlreadyAborted = signal.aborted
    if (isAlreadyAborted) aborted()

    operation.then((value) => {
      signal.removeEventListener('abort', aborted)
      const isAbortRequested = !finished && signal.aborted
      const isLateResult = finished || isAbortRequested
      if (isLateResult) {
        const canDiscard = discard != null
        if (canDiscard) discard(value)
        reject(new LoginFailure(LOGIN_ERRORS.PROVIDER))
        return
      }
      finished = true
      resolve(value)
    }, (error: unknown) => {
      finished = true
      signal.removeEventListener('abort', aborted)
      reject(error)
    })
  })
}

export async function readProviderJson(
  response: Response | undefined,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    const isAborted = signal.aborted
    if (isAborted) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
    const providerResponse = response
    const hasResponse = providerResponse != null
    if (!hasResponse) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
    const isSuccessfulResponse = providerResponse.status === 200
    if (!isSuccessfulResponse) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
    let body: Promise<unknown>
    try {
      // Provider JSON/stream 예외는 원문 객체가 정제 경계를 넘기 전에 분류한다.
      body = providerResponse.json().catch(() => { throw new LoginFailure(LOGIN_ERRORS.PROVIDER) })
    } catch {
      throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
    }
    return await withAbort(body, signal)
  } finally {
    const pendingResponse = response
    const hasResponse = pendingResponse != null
    if (hasResponse) discardResponse(pendingResponse)
    response = undefined
  }
}

export async function exchangeGoogleCode(
  registration: GoogleProviderRegistration,
  input: ProviderVerificationInput | undefined,
  resolveSecret: GoogleProviderConfiguration['resolveSecret'],
  fetchGoogle: typeof globalThis.fetch,
): Promise<unknown> {
  let secret: string | undefined
  let form: URLSearchParams | undefined
  let response: Response | undefined
  const request: RequestInit = { method: 'POST', redirect: 'error', cache: 'no-store' }

  try {
    let signal: AbortSignal
    {
      const providerInput = input
      const hasInput = providerInput != null
      if (!hasInput) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
      signal = providerInput.signal
      const isInitiallyAborted = signal.aborted
      if (isInitiallyAborted) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
      let secretResolution: Promise<string>
      try {
        secretResolution = Promise.resolve(resolveSecret({
          version: registration.snapshot.version,
          reference: registration.snapshot.providerSecretRef,
          signal,
        })).catch(() => { throw new LoginFailure(LOGIN_ERRORS.PROVIDER) })
      } catch {
        throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
      }
      secret = await withAbort(secretResolution, signal)
      const isSecretString = typeof secret === 'string'
      const hasSecret = isSecretString && secret.length > 0
      const isValidSecret = isSecretString && hasSecret
      if (!isValidSecret) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
      const isAbortedAfterSecret = signal.aborted
      if (isAbortedAfterSecret) throw new LoginFailure(LOGIN_ERRORS.PROVIDER)

      form = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registration.snapshot.providerClientId,
        client_secret: secret,
        redirect_uri: registration.snapshot.callbackUrl,
        code: providerInput.code,
        code_verifier: providerInput.providerVerifier,
      })
      request.headers = { 'content-type': 'application/x-www-form-urlencoded' }
      request.signal = signal
      request.body = form
    }
    input = undefined
    secret = undefined

    let tokenRequest: Promise<Response>
    try {
      tokenRequest = fetchGoogle(registration.tokenEndpoint, request)
        .catch(() => { throw new LoginFailure(LOGIN_ERRORS.PROVIDER) })
    } catch {
      throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
    }
    response = await withAbort(tokenRequest, signal, discardResponse)
    // Headers 뒤 body/ID Token/JWKS 대기에 code·verifier·client secret을 넘기지 않는다.
    for (const key of [...form.keys()]) form.delete(key)
    delete request.body
    form = undefined
    return await readProviderJson(response, signal)
  } finally {
    const pendingForm = form
    const hasForm = pendingForm != null
    if (hasForm) {
      for (const key of [...pendingForm.keys()]) pendingForm.delete(key)
    }
    delete request.body
    const pendingResponse = response
    const hasResponse = pendingResponse != null
    if (hasResponse) discardResponse(pendingResponse)
    form = undefined
    response = undefined
    secret = undefined
    input = undefined
  }
}
