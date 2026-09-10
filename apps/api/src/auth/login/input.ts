import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import { UUID_PATTERN } from '../access-jwt/constants.js'
import type { LoginCallbackInput, LoginCreation, LoginExchange } from '../../types/login.js'
import { decodeOpaque } from './crypto.js'

function requireExactFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const isValueTruthy = Boolean(value)
  if (!isValueTruthy) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }
  const isValueObject = typeof value === 'object'
  if (!isValueObject) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }
  const isValueArray = Array.isArray(value)
  if (isValueArray) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  const objectValue = value as Record<string, unknown>
  const hasExpectedFieldCount = Object.keys(objectValue).length === fields.length
  if (!hasExpectedFieldCount) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }
  const hasExpectedFields = fields.every((field) => Object.hasOwn(objectValue, field))
  if (!hasExpectedFields) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  return value as Record<string, unknown>
}

export function parseCreation(value: unknown): LoginCreation {
  const body = requireExactFields(value, [
    'provider',
    'clientId',
    'codeChallenge',
    'codeChallengeMethod'
  ])

  const isSupportedProvider = body.provider === 'google' || body.provider === 'discord'
  if (!isSupportedProvider) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  const isDesktopClient = body.clientId === 'desktop'
  if (!isDesktopClient) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  const isS256CodeChallenge = body.codeChallengeMethod === 'S256'
  const isCreationRequestInvalid = !isS256CodeChallenge

  if (isCreationRequestInvalid) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  decodeOpaque(body.codeChallenge)
  return body as unknown as LoginCreation
}

export function parseExchange(value: unknown): LoginExchange {
  const body = requireExactFields(value, ['requestId', 'clientId', 'code', 'codeVerifier'])

  // Client의 string 형식만 확인한다. 실제 client binding은 exchange transaction에서 확인한다.
  const isRequestIdString = typeof body.requestId === 'string'
  if (!isRequestIdString) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  const isRequestIdValid = UUID_PATTERN.test(body.requestId as string)
  if (!isRequestIdValid) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  const isClientIdString = typeof body.clientId === 'string'
  const isExchangeRequestInvalid = !isClientIdString

  if (isExchangeRequestInvalid) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  decodeOpaque(body.code)
  decodeOpaque(body.codeVerifier)
  return body as unknown as LoginExchange
}

export function parseRefreshToken(value: unknown): string {
  const body = requireExactFields(value, ['refreshToken'])
  const rawToken = body.refreshToken
  const isRefreshTokenString = typeof rawToken === 'string'
  if (!isRefreshTokenString) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }
  return rawToken
}

export function parseCallback(query: URLSearchParams): LoginCallbackInput {
  try {
    const states = query.getAll('state')
    const codes = query.getAll('code')
    const errors = query.getAll('error')

    // OAuth의 다른 query는 허용하되 state 하나와 code/error 중 하나만 받는다.
    const hasSingleState = states.length === 1
    if (!hasSingleState) {
      throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
    }
    const hasSingleOutcome = codes.length + errors.length === 1
    if (!hasSingleOutcome) {
      throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
    }
    const hasTruthyOutcome = Boolean(codes[0] ?? errors[0])
    if (!hasTruthyOutcome) {
      throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
    }

    decodeOpaque(states[0])

    const hasProviderError = errors.length === 1
    if (hasProviderError) {
      return { state: states[0], code: undefined, error: errors[0] }
    }
    return { state: states[0], code: codes[0], error: undefined }
  } catch {
    throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
  }
}
