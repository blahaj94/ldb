import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import { UUID_PATTERN } from '../access-jwt/constants.js'
import type { LoginCallbackInput, LoginCreation, LoginExchange } from '../../types/login.js'
import { decodeOpaque } from './crypto.js'

function requireExactFields(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  if (
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  ) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  return value as Record<string, unknown>
}

export function parseCreation(value: unknown): LoginCreation {
  const body = requireExactFields(value, [
    'provider',
    'clientId',
    'codeChallenge',
    'codeChallengeMethod',
  ])

  if (
    (body.provider !== 'google' && body.provider !== 'discord') ||
    body.clientId !== 'desktop' ||
    body.codeChallengeMethod !== 'S256'
  ) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  decodeOpaque(body.codeChallenge)
  return body as unknown as LoginCreation
}

export function parseExchange(value: unknown): LoginExchange {
  const body = requireExactFields(value, ['requestId', 'clientId', 'code', 'codeVerifier'])

  // Client의 string 형식만 확인한다. 실제 client binding은 exchange transaction에서 확인한다.
  if (
    typeof body.requestId !== 'string' ||
    !UUID_PATTERN.test(body.requestId) ||
    typeof body.clientId !== 'string'
  ) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  decodeOpaque(body.code)
  decodeOpaque(body.codeVerifier)
  return body as unknown as LoginExchange
}

export function parseCallback(query: URLSearchParams): LoginCallbackInput {
  try {
    const states = query.getAll('state')
    const codes = query.getAll('code')
    const errors = query.getAll('error')

    // OAuth의 다른 query는 허용하되 state 하나와 code/error 중 하나만 받는다.
    if (
      states.length !== 1 ||
      codes.length + errors.length !== 1 ||
      !(codes[0] ?? errors[0])
    ) {
      throw new Error()
    }

    decodeOpaque(states[0])

    if (errors.length === 1) {
      return { state: states[0], code: undefined, error: errors[0] }
    }
    return { state: states[0], code: codes[0], error: undefined }
  } catch {
    throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
  }
}
