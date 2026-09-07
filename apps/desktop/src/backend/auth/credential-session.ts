import {
  clearCredential,
  finalizeCredentialTransition,
  finishCredentialClear,
  prepareCredentialTransition
} from './credential-operations'
import type { CredentialCommit, TransitionPreparation } from './credential-operations'
import type {
  AuthAuthorization,
  AuthHttp,
  AuthTokens,
  CredentialStore,
  CredentialTransitionKind,
  StoreMutationOutcome
} from './types'

export type SessionCredential = AuthTokens &
  Readonly<{
    accessTokenExpiresAtMs: number
  }>

type LogoutResult = Readonly<{ localConfirmed: boolean; serverConfirmed: boolean }>

type LogoutOperation = {
  refreshToken: string | null
  writer: CredentialWriter | null
  credentialHttpStarted: boolean
  writerDisposal: Promise<boolean> | undefined
  lateDisposalUnconfirmed: boolean
  result: Promise<LogoutResult> | null
}

export class CredentialWriter {
  readonly completion: Promise<void>
  private resolve!: () => void
  private reject!: (reason: unknown) => void
  private started = false
  private credentialHttpStarted = false
  private tokenlessExchangeUnconfirmed = false

  constructor() {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }

  get httpStarted(): boolean {
    return this.credentialHttpStarted
  }

  get hasUnconfirmedExchange(): boolean {
    return this.tokenlessExchangeUnconfirmed
  }

  markExchangeUnconfirmed(): void {
    this.tokenlessExchangeUnconfirmed = true
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
  private logoutOperation: LogoutOperation | null = null

  constructor(
    private readonly http: Pick<AuthHttp, 'logout' | 'refresh' | 'exchange'>,
    private readonly store: CredentialStore
  ) {}

  get hasWriter(): boolean {
    const hasWriter = this.activeWriter != null
    return hasWriter
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
    const hasExisting = existing != null
    const hasSameGeneration = hasExisting && existing.generation === generation
    if (hasSameGeneration) {
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

  prepare(kind: CredentialTransitionKind): Promise<TransitionPreparation> {
    return prepareCredentialTransition(this.store, kind)
  }

  writeCredential(refreshToken: string): Promise<StoreMutationOutcome> {
    return this.store.commitCredential(refreshToken)
  }

  finalize(kind: CredentialTransitionKind): Promise<CredentialCommit> {
    return finalizeCredentialTransition(this.store, kind)
  }

  reestablish(kind: CredentialTransitionKind): Promise<StoreMutationOutcome> {
    return this.store.reestablishTransition(kind)
  }

  async clearLocal(): Promise<boolean> {
    try {
      const result = await clearCredential(this.store)
      const isCleared = result === 'cleared'
      return isCleared
    } catch {
      return false
    }
  }

  releaseUnsentTransition(): Promise<StoreMutationOutcome> {
    return this.store.removeTransition()
  }

  sendExchange(
    writer: CredentialWriter,
    input: Parameters<AuthHttp['exchange']>[0],
    signal: AbortSignal
  ): ReturnType<AuthHttp['exchange']> {
    writer.markHttpStarted()
    return this.http.exchange(input, signal)
  }

  sendRefresh(writer: CredentialWriter, refreshToken: string): ReturnType<AuthHttp['refresh']> {
    writer.markHttpStarted()
    return this.http.refresh(refreshToken, new AbortController().signal)
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
    const hasExisting = existing != null
    const hasSameRefreshToken = hasExisting && existing.refreshToken === refreshToken
    if (hasSameRefreshToken) {
      return existing.promise
    }

    const promise = (async () => {
      try {
        await this.http.logout(refreshToken, new AbortController().signal)
        return true
      } catch {
        // Known current/consumed token이 있으면 같은 session 폐기는 그 logout 결과로 판단한다.
        const logout = this.logoutOperation
        const hasConcurrentLogout = logout != null
        const hasKnownLogoutCredential = this.knownRefreshToken != null
        const needsLateDisposalConfirmation = hasConcurrentLogout && !hasKnownLogoutCredential
        if (needsLateDisposalConfirmation) {
          logout.lateDisposalUnconfirmed = true
        }
        return false
      }
    })()
    this.disposalFlight = { refreshToken, promise }
    return promise
  }

  beginLogout(): Readonly<LogoutOperation> {
    const existing = this.logoutOperation
    const hasLogout = existing != null
    if (hasLogout) {
      return existing
    }
    const writer = this.activeWriter
    const hasWriter = writer != null
    const operation: LogoutOperation = {
      refreshToken: this.knownRefreshToken,
      writer,
      credentialHttpStarted: hasWriter && writer.httpStarted,
      writerDisposal: hasWriter ? this.disposalFlight?.promise : undefined,
      lateDisposalUnconfirmed: false,
      result: null
    }
    this.logoutOperation = operation
    return operation
  }

  finishLogout(reservation: Readonly<LogoutOperation>): Promise<LogoutResult> {
    const existing = reservation.result
    const hasResult = existing != null
    if (hasResult) {
      return existing
    }
    const operation = this.logoutOperation
    const isOwner = operation === reservation
    if (!isOwner) {
      return Promise.reject(new Error('Credential logout reservation is not current.'))
    }
    let resolve!: (result: LogoutResult) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<LogoutResult>((resolveResult, rejectResult) => {
      resolve = resolveResult
      reject = rejectResult
    })
    operation.result = promise
    void this.performLogout(operation).then(resolve, reject)
    return promise
  }

  private async prepareLocalClear(): Promise<boolean> {
    try {
      const prepared = await this.prepare('clear')
      const isPrepared = prepared === 'established'
      return isPrepared
    } catch {
      return false
    }
  }

  private async finishLocalClear(): Promise<boolean> {
    try {
      const cleared = await finishCredentialClear(this.store)
      const isCleared = cleared === 'cleared'
      return isCleared
    } catch {
      return false
    }
  }

  private async performLogout(operation: LogoutOperation): Promise<LogoutResult> {
    const { writer, refreshToken } = operation
    const hasWriter = writer != null
    const hasKnownLogoutCredential = refreshToken != null
    let localPrepared = false
    let serverLogout: Promise<boolean>
    const canStartServerImmediately = hasWriter && operation.credentialHttpStarted
    if (canStartServerImmediately) {
      serverLogout = hasKnownLogoutCredential ? this.dispose(refreshToken) : Promise.resolve(true)
      await writer.completion.catch(() => undefined)
      localPrepared = await this.prepareLocalClear()
    } else {
      if (hasWriter) {
        await writer.completion.catch(() => undefined)
      }
      localPrepared = await this.prepareLocalClear()
      serverLogout = hasKnownLogoutCredential ? this.dispose(refreshToken) : Promise.resolve(true)
    }
    const serverConfirmed = await serverLogout
    const writerDisposalResult = await operation.writerDisposal
    const hasWriterDisposalFailure = writerDisposalResult === false
    const localConfirmed = localPrepared && (await this.finishLocalClear())
    const hasUnconfirmedExchange = hasWriter && writer.hasUnconfirmedExchange
    const isServerConfirmed =
      serverConfirmed &&
      !hasUnconfirmedExchange &&
      !operation.lateDisposalUnconfirmed &&
      (hasKnownLogoutCredential || !hasWriterDisposalFailure)
    this.discard()
    this.logoutOperation = null
    return { localConfirmed, serverConfirmed: isServerConfirmed }
  }
}
