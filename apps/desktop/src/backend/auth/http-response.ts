import { z } from 'zod'
import { isCanonicalOpaque } from './pkce'
import { validateBrowserLaunchUrl } from './protocol'
import type { AuthTokens, LoginExchangeResponse, LoginRequestResponse, MeResponse } from './types'

const AUTH_RESPONSE_MAX_BYTES = 16_384
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const UTC_ISO_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/

export type AuthHttpFailureCode =
  | 'network'
  | 'unavailable'
  | 'invalid-request'
  | 'exchange-invalid'
  | 'authentication-required'
  | 'invalid-response'

export class AuthHttpFailure extends Error {
  readonly code: AuthHttpFailureCode
  readonly transmission: 'not-sent' | 'unknown'

  constructor(code: AuthHttpFailureCode, transmission: 'not-sent' | 'unknown' = 'unknown') {
    super('Authentication HTTP request failed.')
    this.name = 'AuthHttpFailure'
    this.code = code
    this.transmission = transmission
    this.stack = `${this.name}: ${this.message}`
  }
}

type ErrorDefinitionShape = Readonly<{
  code: string
  message: string
}>

const ERROR_DEFINITIONS = [
  { code: 'INVALID_AUTH_REQUEST', message: '인증 요청을 확인해 주세요.' },
  {
    code: 'LOGIN_EXCHANGE_INVALID',
    message: '로그인 요청이 유효하지 않습니다. 다시 로그인해 주세요.'
  },
  { code: 'AUTHENTICATION_REQUIRED', message: '로그인이 필요합니다.' },
  { code: 'AUTH_INTERNAL_ERROR', message: '인증 요청을 처리하지 못했습니다.' },
  {
    code: 'AUTH_UNAVAILABLE',
    message: '현재 계정 기능을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'
  }
] as const satisfies readonly ErrorDefinitionShape[]

type ErrorCode = (typeof ERROR_DEFINITIONS)[number]['code']

function isUtcIso(value: string): boolean {
  const match = UTC_ISO_PATTERN.exec(value)
  const hasIsoShape = match != null
  if (!hasIsoShape) {
    return false
  }

  const milliseconds = (match[2] ?? '').padEnd(3, '0')
  const normalized = `${match[1]}.${milliseconds}Z`
  const timestamp = Date.parse(normalized)
  const isValidDate = Number.isFinite(timestamp)
  const hasExactDate = isValidDate ? new Date(timestamp).toISOString() === normalized : undefined
  const isValidUtcIso = isValidDate && hasExactDate === true

  return isValidUtcIso
}

const utcIsoSchema = z.string().refine(isUtcIso)
const tokenSchema = z.strictObject({
  tokenType: z.literal('Bearer'),
  accessToken: z.string().regex(COMPACT_JWS_PATTERN).max(8_192),
  accessTokenExpiresAt: utcIsoSchema,
  refreshToken: z.string().refine(isCanonicalOpaque),
  sessionExpiresAt: utcIsoSchema
})
const userSchema = z.strictObject({
  id: z.guid(),
  nickname: z.string().refine((value) => {
    const isWellFormed = value.isWellFormed()

    return isWellFormed
  })
})
const loginRequestSchema = z.strictObject({
  requestId: z.guid(),
  browserUrl: z.string(),
  expiresAt: utcIsoSchema
})
const exchangeSchema = z.strictObject({
  ...tokenSchema.shape,
  user: userSchema,
  isNewUser: z.boolean()
})
const meSchema = z.strictObject({ user: userSchema })
const errorSchema = z.strictObject({
  error: z.union(
    ERROR_DEFINITIONS.map(({ code, message }) =>
      z.strictObject({ code: z.literal(code), message: z.literal(message) })
    )
  )
})

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new AuthHttpFailure('invalid-response')
  }
  return result.data
}

export function parseTokens(value: unknown): AuthTokens {
  return parseResponse(tokenSchema, value)
}

export function parseLoginRequest(value: unknown, apiOrigin: string): LoginRequestResponse {
  const response = parseResponse(loginRequestSchema, value)
  try {
    validateBrowserLaunchUrl(response.browserUrl, apiOrigin)
  } catch {
    throw new AuthHttpFailure('invalid-response')
  }
  return response
}

export function parseExchange(value: unknown): LoginExchangeResponse {
  return parseResponse(exchangeSchema, value)
}

export function parseMe(value: unknown): MeResponse {
  return parseResponse(meSchema, value)
}

function parseError(value: unknown): ErrorCode {
  return parseResponse(errorSchema, value).error.code
}

export async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get('content-type')
  const contentTypeParts = contentType?.split(';').map((part) => part.trim().toLowerCase()) ?? []
  const mediaType = contentTypeParts[0]
  const parameters = contentTypeParts.slice(1)
  const hasJsonMediaType = mediaType === 'application/json'
  const hasNoParameters = parameters.length === 0
  let hasOneParameter: boolean | undefined
  let hasUtf8Charset: boolean | undefined
  if (!hasNoParameters) {
    hasOneParameter = parameters.length === 1
    if (hasOneParameter) {
      hasUtf8Charset = parameters[0] === 'charset=utf-8'
    }
  }
  const hasSupportedParameters = hasNoParameters || hasUtf8Charset
  const hasSupportedContentType = hasJsonMediaType && hasSupportedParameters
  if (!hasSupportedContentType) {
    throw new AuthHttpFailure('invalid-response')
  }

  const declaredLength = response.headers.get('content-length')
  const hasDeclaredLength = declaredLength != null
  const declaredBytes = hasDeclaredLength ? Number(declaredLength) : null
  let hasOversizeDeclaration: boolean | undefined
  if (declaredBytes != null) {
    const hasFiniteDeclaration = Number.isFinite(declaredBytes)
    if (hasFiniteDeclaration) {
      hasOversizeDeclaration = declaredBytes > AUTH_RESPONSE_MAX_BYTES
    }
  }
  if (hasOversizeDeclaration) {
    try {
      await response.body?.cancel()
    } catch {
      // Response는 이미 실패다. Stream cancel 상세는 credential 경계 밖으로 전달하지 않는다.
    }
    throw new AuthHttpFailure('invalid-response')
  }

  const hasBody = response.body != null
  if (!hasBody) {
    throw new AuthHttpFailure('invalid-response')
  }

  const reader = response.body.getReader()
  const cancelReader = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener('abort', cancelReader, { once: true })
  const chunks: Uint8Array[] = []
  let bytesRead = 0
  try {
    while (true) {
      const chunk = await reader.read()
      const reachedEnd = chunk.done
      if (reachedEnd) {
        break
      }
      bytesRead += chunk.value.byteLength
      const isWithinLimit = bytesRead <= AUTH_RESPONSE_MAX_BYTES
      if (!isWithinLimit) {
        await reader.cancel()
        throw new AuthHttpFailure('invalid-response')
      }
      chunks.push(chunk.value)
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader)
  }

  const body = new Uint8Array(bytesRead)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new AuthHttpFailure('invalid-response')
  }
  const isEmpty = text.length === 0
  if (isEmpty) {
    throw new AuthHttpFailure('invalid-response')
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AuthHttpFailure('invalid-response')
  }
}

function classifyError(status: number, code: ErrorCode): AuthHttpFailure {
  const isInternalError = status === 500 && code === 'AUTH_INTERNAL_ERROR'
  const isServiceUnavailable = status === 503 && code === 'AUTH_UNAVAILABLE'
  const isUnavailable = isInternalError || isServiceUnavailable
  if (isUnavailable) {
    return new AuthHttpFailure('unavailable')
  }

  const isInvalidRequest = status === 400 && code === 'INVALID_AUTH_REQUEST'
  if (isInvalidRequest) {
    return new AuthHttpFailure('invalid-request')
  }

  const isExchangeInvalid = status === 400 && code === 'LOGIN_EXCHANGE_INVALID'
  if (isExchangeInvalid) {
    return new AuthHttpFailure('exchange-invalid')
  }

  const isAuthenticationRequired = status === 401 && code === 'AUTHENTICATION_REQUIRED'
  if (isAuthenticationRequired) {
    return new AuthHttpFailure('authentication-required')
  }

  return new AuthHttpFailure('invalid-response')
}

export async function requireSuccessJson(
  response: Response,
  expectedStatus: number,
  signal?: AbortSignal
): Promise<unknown> {
  const value = await readJson(response, signal)
  const hasExpectedStatus = response.status === expectedStatus
  if (hasExpectedStatus) {
    return value
  }

  const code = parseError(value)
  throw classifyError(response.status, code)
}

export async function requireLogoutResponse(
  response: Response,
  signal?: AbortSignal
): Promise<void> {
  const isNoContent = response.status === 204
  const hasNoBody = response.body == null
  const isValidNoContentResponse = isNoContent && hasNoBody
  if (isValidNoContentResponse) {
    return
  }
  if (isNoContent) {
    throw new AuthHttpFailure('invalid-response')
  }

  const value = await readJson(response, signal)
  const code = parseError(value)
  throw classifyError(response.status, code)
}
