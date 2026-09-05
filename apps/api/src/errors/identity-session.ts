import type { AuthErrorCode, AuthErrorDefinition } from '../types/auth.js'

export class IdentitySessionFailure extends Error {
  readonly code: AuthErrorCode
  readonly status: AuthErrorDefinition['status']

  constructor(definition: AuthErrorDefinition) {
    super(definition.message)
    this.name = 'IdentitySessionFailure'
    this.code = definition.code
    this.status = definition.status
  }
}
