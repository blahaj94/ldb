import ky from 'ky'
import { z } from 'zod'
import { validateApiOrigin } from '../auth/protocol'
import type { AuthClock } from '../auth/types'
import { SEARCH_ERRORS } from '../../preload/common/types/search'
import type { CharacterSearchRow, SearchErrorCode } from '../../preload/common/types/search'

const nonblank = z.string().refine((value) => {
  const hasText = value.trim().length > 0
  return hasText
})
const responseSchema = z.object({
  rows: z.array(
    z.object({
      characterId: nonblank,
      characterName: nonblank,
      serverId: nonblank,
      serverName: z.union([z.string(), z.null()]),
      fame: z.union([z.number(), z.null()])
    })
  )
})
const failureSchema = z.object({
  error: z.object({ code: z.string() })
})
const statusErrors: Readonly<Partial<Record<number, SearchErrorCode>>> = {
  400: 'INVALID_SEARCH_QUERY',
  401: 'AUTHENTICATION_REQUIRED',
  429: 'SEARCH_RATE_LIMITED',
  500: 'INTERNAL_SERVER_ERROR',
  502: 'NEOPLE_API_ERROR',
  503: 'NEOPLE_UNAVAILABLE',
  504: 'NEOPLE_TIMEOUT'
}

export class SearchHttpFailure extends Error {
  readonly retryAfterSeconds: number | null
  readonly retryAfterReceivedAt: number | null

  constructor(
    readonly code: SearchErrorCode,
    rateLimit: { retryAfterSeconds: number | null; retryAfterReceivedAt: number | null } = {
      retryAfterSeconds: null,
      retryAfterReceivedAt: null
    }
  ) {
    super(SEARCH_ERRORS[code].message)
    this.name = 'SearchHttpFailure'
    this.retryAfterSeconds = rateLimit.retryAfterSeconds
    this.retryAfterReceivedAt = rateLimit.retryAfterReceivedAt
  }
}

function parseRetryAfter(value: string | null): number | null {
  const hasValue = value != null
  const isDecimal = hasValue && /^[0-9]+$/.test(value)
  const seconds = isDecimal ? Number(value) : Number.NaN
  const isSafeInteger = Number.isSafeInteger(seconds)
  const isPositive = seconds > 0
  const isValid = isDecimal && isSafeInteger && isPositive
  return isValid ? seconds : null
}

export type SearchHttp = (input: {
  nickname: string
  accessToken: string
  signal: AbortSignal
}) => Promise<readonly CharacterSearchRow[]>

export function createSearchHttp({
  apiOrigin,
  fetch: transport = globalThis.fetch,
  clock
}: {
  apiOrigin: string
  fetch?: typeof fetch
  clock?: Pick<AuthClock, 'read'>
}): SearchHttp {
  const origin = validateApiOrigin(apiOrigin)
  const client = ky.create({
    fetch: transport,
    retry: 0,
    timeout: false,
    totalTimeout: false,
    throwHttpErrors: false,
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store'
  })

  return async ({ nickname, accessToken, signal }) => {
    const response = await client.get(`${origin}/characters`, {
      searchParams: { characterName: nickname },
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal
    })
    const receivedAt = clock?.read().monotonicMs ?? performance.now()
    let bytes: ArrayBuffer
    try {
      bytes = await response.arrayBuffer()
    } catch {
      throw new SearchHttpFailure('SEARCH_NETWORK_ERROR')
    }

    let body: unknown
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      body = JSON.parse(text)
    } catch {
      throw new SearchHttpFailure('SEARCH_RESPONSE_INVALID')
    }

    const isSuccess = response.status === 200
    if (!isSuccess) {
      const code = statusErrors[response.status]
      const hasKnownStatus = code != null
      const failure = failureSchema.safeParse(body)
      const hasMatchingCode = failure.success && failure.data.error.code === code
      const isValidFailure = hasKnownStatus && hasMatchingCode
      if (!isValidFailure) {
        throw new SearchHttpFailure('SEARCH_RESPONSE_INVALID')
      }
      const isRateLimited = code === 'SEARCH_RATE_LIMITED'
      throw new SearchHttpFailure(code, {
        retryAfterSeconds: isRateLimited
          ? parseRetryAfter(response.headers.get('Retry-After'))
          : null,
        retryAfterReceivedAt: isRateLimited ? receivedAt : null
      })
    }
    const isObject = body != null && typeof body === 'object' && !Array.isArray(body)
    const hasError = isObject && Object.hasOwn(body, 'error')
    const parsed = responseSchema.safeParse(body)
    const isValidResponse = !hasError && parsed.success
    if (!isValidResponse) {
      throw new SearchHttpFailure('SEARCH_RESPONSE_INVALID')
    }

    return parsed.data.rows
  }
}
