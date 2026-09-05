import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import { UUID_PATTERN } from '../access-jwt/constants.js'
import type { LoginCreation, LoginExchange } from '../../types/login.js'
import { decodeOpaque } from './crypto.js'

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }
  return value as Record<string, unknown>
}

export function parseCreation(value: unknown): LoginCreation {
  const body = object(value, ['provider', 'clientId', 'codeChallenge', 'codeChallengeMethod'])
  if ((body.provider !== 'google' && body.provider !== 'discord') || body.clientId !== 'desktop' || body.codeChallengeMethod !== 'S256') {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }
  decodeOpaque(body.codeChallenge)
  return body as unknown as LoginCreation
}

export function parseExchange(value: unknown): LoginExchange {
  const body = object(value, ['requestId', 'clientId', 'code', 'codeVerifier'])
  if (typeof body.requestId !== 'string' || !UUID_PATTERN.test(body.requestId) || typeof body.clientId !== 'string') {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }
  decodeOpaque(body.code)
  decodeOpaque(body.codeVerifier)
  return body as unknown as LoginExchange
}

export function parseCallback(query: URLSearchParams): { state: string; code?: string; error?: string } {
  try {
    const states = query.getAll('state'), codes = query.getAll('code'), errors = query.getAll('error')
    if (states.length !== 1 || codes.length + errors.length !== 1 || !(codes[0] ?? errors[0])) throw new Error()
    decodeOpaque(states[0])
    return { state: states[0], code: codes[0], error: errors[0] }
  } catch { throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID) }
}
