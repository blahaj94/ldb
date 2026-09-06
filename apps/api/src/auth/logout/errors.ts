import { AUTH_ERRORS } from '../../constants/auth.js'

export const LOGOUT_ERRORS = {
  UNAVAILABLE: AUTH_ERRORS.UNAVAILABLE,
} as const

export type LogoutErrorDefinition = typeof LOGOUT_ERRORS[keyof typeof LOGOUT_ERRORS]

export class LogoutFailure extends Error {
  readonly code: LogoutErrorDefinition['code']
  readonly status: LogoutErrorDefinition['status']

  constructor(definition: LogoutErrorDefinition) {
    super(definition.message)
    this.name = 'LogoutFailure'
    this.code = definition.code
    this.status = definition.status
    this.stack = `${this.name}: ${this.message}`
  }
}
