const messages = {
  INVALID_ACCESS_JWT_CONFIGURATION: 'Invalid access JWT configuration',
  INVALID_ACCESS_JWT_INPUT: 'Invalid access JWT input',
  INVALID_ACCESS_JWT: 'Invalid access JWT',
  ACCESS_JWT_SIGNING_FAILED: 'Access JWT signing failed',
} as const

export class AccessJwtError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code])
    this.name = 'AccessJwtError'
  }
}
