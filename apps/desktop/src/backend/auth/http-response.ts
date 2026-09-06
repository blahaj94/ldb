import { isCanonicalOpaque } from './pkce'
import { validateBrowserLaunchUrl } from './protocol'
import type { AuthTokens, LoginExchangeResponse, LoginRequestResponse, MeResponse } from './types'

const AUTH_RESPONSE_MAX_BYTES = 16_384
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
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

type ErrorCode =
  | 'INVALID_AUTH_REQUEST'
  | 'LOGIN_EXCHANGE_INVALID'
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTH_INTERNAL_ERROR'
  | 'AUTH_UNAVAILABLE'

const ERROR_MESSAGES = {
  INVALID_AUTH_REQUEST: '인증 요청을 확인해 주세요.',
  LOGIN_EXCHANGE_INVALID: '로그인 요청이 유효하지 않습니다. 다시 로그인해 주세요.',
  AUTHENTICATION_REQUIRED: '로그인이 필요합니다.',
  AUTH_INTERNAL_ERROR: '인증 요청을 처리하지 못했습니다.',
  AUTH_UNAVAILABLE: '현재 계정 기능을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'
} as const satisfies Record<ErrorCode, string>

function hasExactFields(value: object, fields: readonly string[]): boolean {
  const keys = Object.keys(value)
  const hasExpectedCount = keys.length === fields.length
  const hasEveryField = fields.every((field) => Object.hasOwn(value, field))
  const hasOnlyExpectedFields = hasExpectedCount && hasEveryField

  return hasOnlyExpectedFields
}

function isObject(value: unknown): value is Record<string, unknown> {
  const isNonNull = value != null
  const hasObjectType = isNonNull && typeof value === 'object'
  const isArray = hasObjectType && Array.isArray(value)
  const isRecord = hasObjectType && !isArray

  return isRecord
}

function isUuid(value: unknown): value is string {
  const isString = typeof value === 'string'
  const isValidUuid = isString && UUID_PATTERN.test(value)

  return isValidUuid
}

function isUtcIso(value: unknown): value is string {
  const isString = typeof value === 'string'
  const match = isString ? UTC_ISO_PATTERN.exec(value) : null
  const hasIsoShape = match != null
  if (!hasIsoShape) {
    return false
  }

  const milliseconds = (match[2] ?? '').padEnd(3, '0')
  const normalized = `${match[1]}.${milliseconds}Z`
  const timestamp = Date.parse(normalized)
  const isValidDate = Number.isFinite(timestamp)
  const hasExactDate = isValidDate && new Date(timestamp).toISOString() === normalized
  const isValidUtcIso = isValidDate && hasExactDate

  return isValidUtcIso
}

function isWellFormedString(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    const isHighSurrogate = codeUnit >= 0xd800 && codeUnit <= 0xdbff
    const isLowSurrogate = codeUnit >= 0xdc00 && codeUnit <= 0xdfff
    if (isHighSurrogate) {
      const next = value.charCodeAt(index + 1)
      const hasLowSurrogate = next >= 0xdc00 && next <= 0xdfff
      if (!hasLowSurrogate) {
        return false
      }
      index += 1
    } else if (isLowSurrogate) {
      return false
    }
  }

  return true
}

export function parseTokens(value: unknown): AuthTokens {
  const isTokenObject = isObject(value)
  if (!isTokenObject) {
    throw new AuthHttpFailure('invalid-response')
  }

  const fields = [
    'tokenType',
    'accessToken',
    'accessTokenExpiresAt',
    'refreshToken',
    'sessionExpiresAt'
  ]
  const hasTokenFields = hasExactFields(value, fields)
  const isBearer = value.tokenType === 'Bearer'
  const accessTokenField = value.accessToken
  const isAccessTokenString = typeof accessTokenField === 'string'
  const isAccessTokenWithinLimit = isAccessTokenString && accessTokenField.length <= 8_192
  const isCompactAccessToken =
    isAccessTokenWithinLimit && COMPACT_JWS_PATTERN.test(accessTokenField)
  const hasAccessExpiry = isUtcIso(value.accessTokenExpiresAt)
  const hasRefreshToken = isCanonicalOpaque(value.refreshToken)
  const hasSessionExpiry = isUtcIso(value.sessionExpiresAt)
  const isValidTokenResponse =
    hasTokenFields &&
    isBearer &&
    isCompactAccessToken &&
    hasAccessExpiry &&
    hasRefreshToken &&
    hasSessionExpiry
  if (!isValidTokenResponse) {
    throw new AuthHttpFailure('invalid-response')
  }

  return {
    tokenType: 'Bearer',
    accessToken: value.accessToken as string,
    accessTokenExpiresAt: value.accessTokenExpiresAt as string,
    refreshToken: value.refreshToken as string,
    sessionExpiresAt: value.sessionExpiresAt as string
  }
}

function parseUser(value: unknown): Readonly<{ id: string; nickname: string }> {
  const isUserObject = isObject(value)
  if (!isUserObject) {
    throw new AuthHttpFailure('invalid-response')
  }

  const hasUserFields = hasExactFields(value, ['id', 'nickname'])
  const hasUserId = isUuid(value.id)
  const hasNickname = isWellFormedString(value.nickname)
  const isValidUser = hasUserFields && hasUserId && hasNickname
  if (!isValidUser) {
    throw new AuthHttpFailure('invalid-response')
  }

  return { id: value.id as string, nickname: value.nickname as string }
}

export function parseLoginRequest(value: unknown, apiOrigin: string): LoginRequestResponse {
  const isResponseObject = isObject(value)
  if (!isResponseObject) {
    throw new AuthHttpFailure('invalid-response')
  }

  const hasFields = hasExactFields(value, ['requestId', 'browserUrl', 'expiresAt'])
  const hasRequestId = isUuid(value.requestId)
  const hasExpiry = isUtcIso(value.expiresAt)
  let browserUrl: string
  try {
    browserUrl = validateBrowserLaunchUrl(value.browserUrl, apiOrigin)
  } catch {
    throw new AuthHttpFailure('invalid-response')
  }
  const isValidResponse = hasFields && hasRequestId && hasExpiry
  if (!isValidResponse) {
    throw new AuthHttpFailure('invalid-response')
  }

  return {
    requestId: value.requestId as string,
    browserUrl,
    expiresAt: value.expiresAt as string
  }
}

export function parseExchange(value: unknown): LoginExchangeResponse {
  const isResponseObject = isObject(value)
  if (!isResponseObject) {
    throw new AuthHttpFailure('invalid-response')
  }

  const fields = [
    'tokenType',
    'accessToken',
    'accessTokenExpiresAt',
    'refreshToken',
    'sessionExpiresAt',
    'user',
    'isNewUser'
  ]
  const hasFields = hasExactFields(value, fields)
  const isNewUser = typeof value.isNewUser === 'boolean'
  if (!hasFields || !isNewUser) {
    throw new AuthHttpFailure('invalid-response')
  }

  const tokens = parseTokens({
    tokenType: value.tokenType,
    accessToken: value.accessToken,
    accessTokenExpiresAt: value.accessTokenExpiresAt,
    refreshToken: value.refreshToken,
    sessionExpiresAt: value.sessionExpiresAt
  })
  const user = parseUser(value.user)

  return { ...tokens, user, isNewUser: value.isNewUser as boolean }
}

export function parseMe(value: unknown): MeResponse {
  const isResponseObject = isObject(value)
  if (!isResponseObject) {
    throw new AuthHttpFailure('invalid-response')
  }

  const hasFields = hasExactFields(value, ['user'])
  if (!hasFields) {
    throw new AuthHttpFailure('invalid-response')
  }

  return { user: parseUser(value.user) }
}

function parseError(value: unknown): ErrorCode {
  const isResponseObject = isObject(value)
  const hasErrorOnly = isResponseObject && hasExactFields(value, ['error'])
  const errorValue = hasErrorOnly ? value.error : null
  const isErrorObject = isObject(errorValue)
  const hasErrorFields = isErrorObject && hasExactFields(errorValue, ['code', 'message'])
  const code = hasErrorFields ? errorValue.code : null
  const message = hasErrorFields ? errorValue.message : null
  const isKnownCode = typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)
  const hasExpectedMessage =
    isKnownCode && typeof message === 'string' && ERROR_MESSAGES[code as ErrorCode] === message
  const isValidError =
    hasErrorOnly && isErrorObject && hasErrorFields && isKnownCode && hasExpectedMessage
  if (!isValidError) {
    throw new AuthHttpFailure('invalid-response')
  }

  return code as ErrorCode
}

export async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get('content-type')
  const contentTypeParts = contentType?.split(';').map((part) => part.trim().toLowerCase()) ?? []
  const mediaType = contentTypeParts[0]
  const parameters = contentTypeParts.slice(1)
  const hasJsonMediaType = mediaType === 'application/json'
  const hasSupportedParameters =
    parameters.length === 0 || (parameters.length === 1 && parameters[0] === 'charset=utf-8')
  const hasSupportedContentType = hasJsonMediaType && hasSupportedParameters
  if (!hasSupportedContentType) {
    throw new AuthHttpFailure('invalid-response')
  }

  const declaredLength = response.headers.get('content-length')
  const declaredBytes = declaredLength == null ? null : Number(declaredLength)
  const hasOversizeDeclaration =
    declaredBytes != null &&
    Number.isFinite(declaredBytes) &&
    declaredBytes > AUTH_RESPONSE_MAX_BYTES
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
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener('abort', cancelReader, { once: true })
  const chunks: Uint8Array[] = []
  let bytesRead = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
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
  const isUnavailable =
    (status === 500 && code === 'AUTH_INTERNAL_ERROR') ||
    (status === 503 && code === 'AUTH_UNAVAILABLE')
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
  if (isNoContent && hasNoBody) {
    return
  }
  if (isNoContent) {
    throw new AuthHttpFailure('invalid-response')
  }

  const value = await readJson(response, signal)
  const code = parseError(value)
  throw classifyError(response.status, code)
}
