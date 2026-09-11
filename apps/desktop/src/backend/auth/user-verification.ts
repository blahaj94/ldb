import { AuthHttpFailure } from './http'
import type { AuthHttp, AuthNotice } from './types'

type VerificationOperation = Readonly<{ controller: AbortController }>
type VerificationFailureNotice = Extract<
  AuthNotice,
  'REAUTH_REQUIRED' | 'NETWORK_UNAVAILABLE' | 'AUTH_SERVICE_UNAVAILABLE'
>

export function verificationFailureNotice(error: unknown): VerificationFailureNotice {
  const isHttpFailure = error instanceof AuthHttpFailure
  if (!isHttpFailure) {
    return 'AUTH_SERVICE_UNAVAILABLE'
  }

  const needsAuthentication = error.code === 'authentication-required'
  if (needsAuthentication) {
    return 'REAUTH_REQUIRED'
  }

  const isNetwork = error.code === 'network'
  return isNetwork ? 'NETWORK_UNAVAILABLE' : 'AUTH_SERVICE_UNAVAILABLE'
}

export class UserVerification {
  private current: VerificationOperation | null = null

  constructor(private readonly http: Pick<AuthHttp, 'me'>) {}

  reserve(): VerificationOperation {
    const operation = { controller: new AbortController() }
    this.current = operation
    return operation
  }

  send(operation: VerificationOperation, accessToken: string): ReturnType<AuthHttp['me']> {
    return this.http.me(accessToken, operation.controller.signal)
  }

  complete(operation: VerificationOperation): void {
    const isCurrent = this.current === operation
    if (isCurrent) {
      this.current = null
    }
  }

  abort(): void {
    this.current?.controller.abort()
  }
}
