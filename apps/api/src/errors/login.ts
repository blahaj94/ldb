import { LOGIN_ERRORS } from '../constants/login.js'
import { IdentitySessionFailure } from './identity-session.js'
import type { LoginErrorDefinition } from '../types/login.js'

export class LoginFailure extends Error {
  readonly code: LoginErrorDefinition['code']
  readonly status: LoginErrorDefinition['status']

  constructor(definition: LoginErrorDefinition) {
    super(definition.message)
    this.name = 'LoginFailure'
    this.code = definition.code
    this.status = definition.status
    this.stack = `${this.name}: ${this.message}`
  }
}

export function loginFailure(
  error: unknown,
  fallback: LoginErrorDefinition = LOGIN_ERRORS.INTERNAL,
): LoginFailure {
  if (error instanceof LoginFailure) {
    return error
  }

  if (error instanceof IdentitySessionFailure) {
    const definition = error.code === LOGIN_ERRORS.UNAVAILABLE.code
      ? LOGIN_ERRORS.UNAVAILABLE
      : LOGIN_ERRORS.INTERNAL
    return new LoginFailure(definition)
  }

  return new LoginFailure(fallback)
}
