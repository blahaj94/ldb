import ky from 'ky'
import type { Options } from 'ky'
import {
  AuthHttpFailure,
  parseExchange,
  parseLoginRequest,
  parseMe,
  parseTokens,
  requireLogoutResponse,
  requireSuccessJson
} from './http-response'
import { validateApiOrigin } from './protocol'
import type { AuthHttp } from './types'

export { AuthHttpFailure } from './http-response'

const AUTH_HTTP_DEADLINE_MS = 15_000

type AuthHttpClientConfiguration = Readonly<{
  apiOrigin: string
  fetch?: typeof globalThis.fetch
}>

export function createAuthHttpClient(configuration: AuthHttpClientConfiguration): AuthHttp {
  const apiOrigin = validateApiOrigin(configuration.apiOrigin)
  const fetchAuth = configuration.fetch ?? globalThis.fetch
  const canFetch = typeof fetchAuth === 'function'
  if (!canFetch) {
    throw new AuthHttpFailure('invalid-response')
  }
  const client = ky.create({
    fetch: fetchAuth,
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    redirect: 'error',
    cache: 'no-store',
    credentials: 'omit',
    retry: 0,
    // Ky의 별도 header/body 예산 대신 아래 단일 deadline이 stream 완료까지 소유한다.
    timeout: false,
    totalTimeout: false,
    // Ky error.data의 자동 body 읽기 대신 모든 응답에 앱의 16 KiB 경계를 적용한다.
    throwHttpErrors: false
  })

  async function withDeadline<T>(
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const wasCancelledBeforeStart = callerSignal.aborted
    if (wasCancelledBeforeStart) {
      throw new AuthHttpFailure('network', 'not-sent')
    }

    const controller = new AbortController()
    let rejectAbort!: (failure: AuthHttpFailure) => void
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    const abort = (): void => {
      controller.abort()
      rejectAbort(new AuthHttpFailure('network'))
    }
    callerSignal.addEventListener('abort', abort, { once: true })
    const deadline = setTimeout(abort, AUTH_HTTP_DEADLINE_MS)

    try {
      return await Promise.race([operation(controller.signal), aborted])
    } catch (error) {
      const isAuthHttpFailure = error instanceof AuthHttpFailure
      if (isAuthHttpFailure) {
        throw error
      }
      throw new AuthHttpFailure('network')
    } finally {
      clearTimeout(deadline)
      callerSignal.removeEventListener('abort', abort)
    }
  }

  async function requestJson(
    path: string,
    request: Options,
    callerSignal: AbortSignal,
    expectedStatus: number
  ): Promise<unknown> {
    return withDeadline(callerSignal, async (signal) => {
      const response = await client(`${apiOrigin}${path}`, { ...request, signal })
      return requireSuccessJson(response, expectedStatus, signal)
    })
  }

  return {
    async createLoginRequest(input, signal) {
      const value = await requestJson('/auth/login-requests', { json: input }, signal, 201)
      return parseLoginRequest(value, apiOrigin)
    },

    async exchange(input, signal) {
      const value = await requestJson('/auth/exchange', { json: input }, signal, 200)
      return parseExchange(value)
    },

    async refresh(refreshToken, signal) {
      const value = await requestJson('/auth/refresh', { json: { refreshToken } }, signal, 200)
      return parseTokens(value)
    },

    async logout(refreshToken, callerSignal) {
      await withDeadline(callerSignal, async (signal) => {
        const response = await client(`${apiOrigin}/auth/logout`, {
          json: { refreshToken },
          signal
        })
        await requireLogoutResponse(response, signal)
      })
    },

    async me(accessToken, signal) {
      const value = await requestJson(
        '/me',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` }
        },
        signal,
        200
      )
      return parseMe(value)
    }
  }
}
