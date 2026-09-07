import type { AuthAuthorization, AuthHttp, AuthTokens } from './types'

export type SessionCredential = AuthTokens &
  Readonly<{
    accessTokenExpiresAtMs: number
  }>

type LogoutCredentials = Readonly<{
  refreshToken: string | null
  writer: Promise<void> | null
  credentialHttpStarted: boolean
  writerDisposal: Promise<boolean> | undefined
}>

export class CredentialWriter {
  readonly completion: Promise<void>
  private resolve!: () => void
  private reject!: (reason: unknown) => void
  private started = false
  private credentialHttpStarted = false

  constructor() {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }

  get httpStarted(): boolean {
    return this.credentialHttpStarted
  }

  markHttpStarted(): void {
    this.credentialHttpStarted = true
  }

  execute(operation: () => Promise<void>): Promise<void> {
    if (this.started) {
      return this.completion
    }
    this.started = true
    try {
      void operation().then(this.resolve, this.reject)
    } catch (error) {
      this.reject(error)
    }
    return this.completion
  }
}

export class CredentialSession {
  private credential: SessionCredential | null = null
  private knownRefreshToken: string | null = null
  private disposalFlight: Readonly<{ refreshToken: string; promise: Promise<boolean> }> | null =
    null
  private activeWriter: CredentialWriter | null = null
  private refreshFlight: Readonly<{
    generation: number
    promise: Promise<AuthAuthorization>
  }> | null = null
  private logoutInProgress = false
  private lateDisposalUnconfirmed = false

  constructor(private readonly http: Pick<AuthHttp, 'logout'>) {}

  get hasWriter(): boolean {
    return this.activeWriter != null
  }

  reserveWriter(): CredentialWriter {
    const writer = new CredentialWriter()
    this.activeWriter = writer
    const clearWriter = (): void => {
      const isCurrentWriter = this.activeWriter === writer
      if (isCurrentWriter) {
        this.activeWriter = null
      }
    }
    void writer.completion.then(clearWriter, clearWriter)
    return writer
  }

  runWriter(operation: (writer: CredentialWriter) => Promise<void>): Promise<void> {
    const writer = this.reserveWriter()
    return writer.execute(() => operation(writer))
  }

  shareRefresh(
    generation: number,
    operation: () => Promise<AuthAuthorization>
  ): Promise<AuthAuthorization> {
    const existing = this.refreshFlight
    const canJoin = existing != null && existing.generation === generation
    if (canJoin) {
      return existing.promise
    }
    let resolve!: (result: AuthAuthorization) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<AuthAuthorization>((resolveResult, rejectResult) => {
      resolve = resolveResult
      reject = rejectResult
    })
    this.refreshFlight = { generation, promise }
    const clearRefresh = (): void => {
      const isCurrentRefresh = this.refreshFlight?.promise === promise
      if (isCurrentRefresh) {
        this.refreshFlight = null
      }
    }
    void promise.then(clearRefresh, clearRefresh)
    try {
      void operation().then(resolve, reject)
    } catch (error) {
      reject(error)
    }
    return promise
  }

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

  beginLogout(): LogoutCredentials {
    this.logoutInProgress = true
    const writer = this.activeWriter
    const hasWriter = writer != null
    return {
      refreshToken: this.knownRefreshToken,
      writer: hasWriter ? writer.completion : null,
      credentialHttpStarted: hasWriter && writer.httpStarted,
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
