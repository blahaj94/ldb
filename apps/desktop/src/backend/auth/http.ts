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

function requestHeaders(authorization?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
  const hasAuthorization = authorization != null
  if (hasAuthorization) {
    headers.Authorization = authorization
  }
  return headers
}

export function createAuthHttpClient(configuration: AuthHttpClientConfiguration): AuthHttp {
  const apiOrigin = validateApiOrigin(configuration.apiOrigin)
  const fetchAuth = configuration.fetch ?? globalThis.fetch
  const canFetch = typeof fetchAuth === 'function'
  if (!canFetch) {
    throw new AuthHttpFailure('invalid-response')
  }

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
    const abort = () => {
      controller.abort()
      rejectAbort(new AuthHttpFailure('network'))
    }
    callerSignal.addEventListener('abort', abort, { once: true })
    const deadline = setTimeout(abort, AUTH_HTTP_DEADLINE_MS)

    try {
      return await Promise.race([operation(controller.signal), aborted])
    } catch (error) {
      if (error instanceof AuthHttpFailure) {
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
    request: RequestInit,
    callerSignal: AbortSignal,
    expectedStatus: number
  ): Promise<unknown> {
    return withDeadline(callerSignal, async (signal) => {
      const response = await fetchAuth(`${apiOrigin}${path}`, {
        ...request,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal
      })
      return requireSuccessJson(response, expectedStatus, signal)
    })
  }

  return {
    async createLoginRequest(input, signal) {
      const value = await requestJson(
        '/auth/login-requests',
        {
          method: 'POST',
          headers: requestHeaders(),
          body: JSON.stringify(input)
        },
        signal,
        201
      )
      return parseLoginRequest(value, apiOrigin)
    },

    async exchange(input, signal) {
      const value = await requestJson(
        '/auth/exchange',
        {
          method: 'POST',
          headers: requestHeaders(),
          body: JSON.stringify(input)
        },
        signal,
        200
      )
      return parseExchange(value)
    },

    async refresh(refreshToken, signal) {
      const value = await requestJson(
        '/auth/refresh',
        {
          method: 'POST',
          headers: requestHeaders(),
          body: JSON.stringify({ refreshToken })
        },
        signal,
        200
      )
      return parseTokens(value)
    },

    async logout(refreshToken, callerSignal) {
      await withDeadline(callerSignal, async (signal) => {
        const response = await fetchAuth(`${apiOrigin}/auth/logout`, {
          method: 'POST',
          headers: requestHeaders(),
          body: JSON.stringify({ refreshToken }),
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
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
          headers: requestHeaders(`Bearer ${accessToken}`)
        },
        signal,
        200
      )
      return parseMe(value)
    }
  }
}
