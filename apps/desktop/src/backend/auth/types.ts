export type AuthProvider = 'google' | 'discord'

export type AuthPhase =
  | 'signedOut'
  | 'startingLogin'
  | 'waitingBrowser'
  | 'exchanging'
  | 'restoring'
  | 'restorePaused'
  | 'signedIn'
  | 'signingOut'
  | 'storageBlocked'

export type AuthNotice =
  | 'LOGIN_CANCELLED'
  | 'LOGIN_EXPIRED'
  | 'LOGIN_RETURN_INVALID'
  | 'LOGIN_RESTART_REQUIRED'
  | 'BROWSER_OPEN_FAILED'
  | 'NETWORK_UNAVAILABLE'
  | 'AUTH_SERVICE_UNAVAILABLE'
  | 'REAUTH_REQUIRED'
  | 'SECURE_STORAGE_UNAVAILABLE'
  | 'TOKEN_SAVE_FAILED'
  | 'LOCAL_CLEAR_UNCONFIRMED'
  | 'LOGOUT_SERVER_UNCONFIRMED'

export type AuthCommandError =
  | 'INVALID_AUTH_COMMAND'
  | 'AUTH_NOT_ALLOWED'
  | 'AUTH_BUSY'
  | 'STALE_ATTEMPT'
  | 'AUTH_OPERATION_FAILED'

export type AuthSnapshot = Readonly<{
  runId: string
  revision: number
  phase: AuthPhase
  providers: readonly AuthProvider[]
  login: Readonly<{
    attemptId: string
    provider: AuthProvider
    expiresAt: string | null
  }> | null
  user: Readonly<{ nickname: string }> | null
  entry: 'welcome' | 'home' | null
  notice: AuthNotice | null
}>

export type AuthCommandResult =
  | Readonly<{ ok: true; snapshot: AuthSnapshot }>
  | Readonly<{
      ok: false
      error: Readonly<{ code: AuthCommandError }>
      snapshot: AuthSnapshot
    }>

export type AuthAuthorization =
  | Readonly<{
      status: 'available'
      accessToken: string
      generation: number
      accessGeneration: number
    }>
  | Readonly<{ status: 'unavailable' }>

export type RejectedAuthorization = Readonly<{
  generation: number
  accessGeneration: number
  finalRejection: boolean
}>

export type AuthTokens = Readonly<{
  tokenType: 'Bearer'
  accessToken: string
  accessTokenExpiresAt: string
  refreshToken: string
  sessionExpiresAt: string
}>

export type LoginExchangeResponse = AuthTokens &
  Readonly<{
    user: Readonly<{ id: string; nickname: string }>
    isNewUser: boolean
  }>

export type LoginRequestResponse = Readonly<{
  requestId: string
  browserUrl: string
  expiresAt: string
}>

export type MeResponse = Readonly<{
  user: Readonly<{ id: string; nickname: string }>
}>

export interface AuthHttp {
  createLoginRequest(
    input: Readonly<{
      provider: AuthProvider
      clientId: 'desktop'
      codeChallenge: string
      codeChallengeMethod: 'S256'
    }>,
    signal: AbortSignal
  ): Promise<LoginRequestResponse>
  exchange(
    input: Readonly<{
      requestId: string
      clientId: 'desktop'
      code: string
      codeVerifier: string
    }>,
    signal: AbortSignal
  ): Promise<LoginExchangeResponse>
  refresh(refreshToken: string, signal: AbortSignal): Promise<AuthTokens>
  logout(refreshToken: string, signal: AbortSignal): Promise<void>
  me(accessToken: string, signal: AbortSignal): Promise<MeResponse>
}

export type ClockReading = Readonly<{
  wallMs: number
  monotonicMs: number
  discontinuous: boolean
}>

export interface AuthClock {
  read(): ClockReading
  schedule(delayMs: number, callback: () => void): () => void
}

export interface AuthEntropy {
  uuid(): string
  bytes(size: number): Uint8Array
}

export type StoreMutationOutcome = 'confirmed' | 'failed' | 'unknown'
export type CredentialTransitionKind = 'exchange' | 'refresh' | 'clear'

export type CredentialInspection =
  | Readonly<{ status: 'empty' }>
  | Readonly<{ status: 'ready'; refreshToken: string }>
  | Readonly<{ status: 'recovery-required' }>
  | Readonly<{ status: 'unavailable' }>

export interface CredentialStore {
  inspect(): Promise<CredentialInspection>
  establishTransition(kind: CredentialTransitionKind): Promise<StoreMutationOutcome>
  commitCredential(refreshToken: string): Promise<StoreMutationOutcome>
  clearCredential(): Promise<StoreMutationOutcome>
  removeTransition(): Promise<StoreMutationOutcome>
  reestablishTransition(kind: CredentialTransitionKind): Promise<StoreMutationOutcome>
}

export interface AuthBrowser {
  open(url: string): Promise<void>
}

export type AuthCoordinatorDependencies = Readonly<{
  providers: readonly AuthProvider[]
  apiOrigin: string
  returnTarget: string
  browser: AuthBrowser
  clock: AuthClock
  entropy: AuthEntropy
  http: AuthHttp
  store: CredentialStore
}>

export interface AuthCoordinator {
  getSnapshot(): AuthSnapshot
  subscribe(listener: (snapshot: AuthSnapshot) => void): () => void
  start(): Promise<AuthSnapshot>
  beginLogin(provider: unknown): Promise<AuthCommandResult>
  cancelLogin(attemptId: unknown): Promise<AuthCommandResult>
  handleReturnUrl(raw: unknown): Promise<void>
  retryAuth(): Promise<AuthCommandResult>
  captureGeneration(): number | null
  authorization(signal?: AbortSignal): Promise<AuthAuthorization>
  recoverAuthorization(
    rejected: RejectedAuthorization,
    signal?: AbortSignal
  ): Promise<AuthAuthorization>
  logout(): Promise<AuthCommandResult>
}
