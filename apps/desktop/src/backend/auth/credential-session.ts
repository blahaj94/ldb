import type { AuthHttp, AuthTokens } from './types'

export type SessionCredential = AuthTokens &
  Readonly<{
    accessTokenExpiresAtMs: number
  }>

type LogoutCredentials = Readonly<{
  refreshToken: string | null
  writerDisposal: Promise<boolean> | undefined
}>

export class CredentialSession {
  private credential: SessionCredential | null = null
  private knownRefreshToken: string | null = null
  private disposalFlight: Readonly<{ refreshToken: string; promise: Promise<boolean> }> | null =
    null
  private logoutInProgress = false
  private lateDisposalUnconfirmed = false

  constructor(private readonly http: Pick<AuthHttp, 'logout'>) {}

  get current(): SessionCredential | null {
    return this.credential
  }

  get knownRefresh(): string | null {
    return this.knownRefreshToken
  }

  acceptCommitted(tokens: AuthTokens): void {
    this.credential = {
      ...tokens,
      accessTokenExpiresAtMs: Date.parse(tokens.accessTokenExpiresAt)
    }
    this.knownRefreshToken = tokens.refreshToken
    this.disposalFlight = null
  }

  retainForRestore(refreshToken: string): void {
    this.knownRefreshToken = refreshToken
  }

  blockAccess(): void {
    this.credential = null
  }

  discard(): void {
    this.credential = null
    this.knownRefreshToken = null
    this.disposalFlight = null
  }

  completeStaleCleanup(): void {
    this.disposalFlight = null
  }

  dispose(refreshToken: string): Promise<boolean> {
    const existing = this.disposalFlight
    const canJoin = existing != null && existing.refreshToken === refreshToken
    if (canJoin) {
      return existing.promise
    }

    const promise = (async () => {
      try {
        await this.http.logout(refreshToken, new AbortController().signal)
        return true
      } catch {
        // Known current/consumed token이 있으면 같은 session 폐기는 그 logout 결과로 판단한다.
        const hasKnownLogoutCredential = this.knownRefreshToken != null
        const needsLateDisposalConfirmation = this.logoutInProgress && !hasKnownLogoutCredential
        if (needsLateDisposalConfirmation) {
          this.lateDisposalUnconfirmed = true
        }
        return false
      }
    })()
    this.disposalFlight = { refreshToken, promise }
    return promise
  }

  beginLogout(hasWriter: boolean): LogoutCredentials {
    this.logoutInProgress = true
    return {
      refreshToken: this.knownRefreshToken,
      writerDisposal: hasWriter ? this.disposalFlight?.promise : undefined
    }
  }

  completeLogout(
    credentials: LogoutCredentials,
    serverConfirmed: boolean,
    writerDisposalResult: boolean | undefined
  ): boolean {
    const hasWriterDisposalFailure = writerDisposalResult === false
    const hasKnownLogoutCredential = credentials.refreshToken != null
    const isServerConfirmed =
      serverConfirmed &&
      !this.lateDisposalUnconfirmed &&
      (hasKnownLogoutCredential || !hasWriterDisposalFailure)
    this.discard()
    this.lateDisposalUnconfirmed = false
    this.logoutInProgress = false
    return isServerConfirmed
  }
}
