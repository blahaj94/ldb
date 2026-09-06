import type { ProviderVerificationInput } from '../../types/login.js'
import type { GoogleProviderConfiguration, GoogleProviderRegistration } from './types.js'

export function discardResponse(response: Response): void {
  // 이미 읽기 중인 native stream은 fetch의 같은 signal로 취소된다.
  void response.body?.cancel().catch(() => undefined)
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
      reject(new Error())
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()

    operation.then((value) => {
      signal.removeEventListener('abort', aborted)
      if (finished || signal.aborted) {
        discard?.(value)
        reject(new Error())
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
    signal.throwIfAborted()
    if (!response || response.status !== 200) throw new Error()
    return await withAbort(response.json(), signal)
  } finally {
    if (response) discardResponse(response)
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
    if (!input) throw new Error()
    const signal = input.signal
    signal.throwIfAborted()
    secret = await withAbort(Promise.resolve(resolveSecret({
      version: registration.snapshot.version,
      reference: registration.snapshot.providerSecretRef,
      signal,
    })), signal)
    if (typeof secret !== 'string' || secret.length === 0) throw new Error()
    signal.throwIfAborted()

    form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: registration.snapshot.providerClientId,
      client_secret: secret,
      redirect_uri: registration.snapshot.callbackUrl,
      code: input.code,
      code_verifier: input.providerVerifier,
    })
    request.headers = { 'content-type': 'application/x-www-form-urlencoded' }
    request.signal = signal
    request.body = form
    input = undefined
    secret = undefined

    response = await withAbort(fetchGoogle(registration.tokenEndpoint, request), signal, discardResponse)
    // Headers 뒤 body/ID Token/JWKS 대기에 code·verifier·client secret을 넘기지 않는다.
    for (const key of [...form.keys()]) form.delete(key)
    delete request.body
    form = undefined
    return await readProviderJson(response, signal)
  } finally {
    if (form) {
      for (const key of [...form.keys()]) form.delete(key)
    }
    delete request.body
    if (response) discardResponse(response)
    form = undefined
    response = undefined
    secret = undefined
    input = undefined
  }
}
