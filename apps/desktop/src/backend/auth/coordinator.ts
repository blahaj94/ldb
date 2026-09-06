import { createHash } from 'node:crypto'
import {
  clearCredential,
  finalizeCredentialTransition,
  finishCredentialClear,
  prepareCredentialTransition
} from './credential-operations'
import { AuthHttpFailure } from './http'
import { createPkce } from './pkce'
import { parseReturnUrl, validateApiOrigin, validateReturnTarget } from './protocol'
import type {
  AuthAuthorization,
  AuthCommandError,
  AuthCommandResult,
  AuthCoordinator,
  AuthCoordinatorDependencies,
  AuthNotice,
  AuthPhase,
  AuthProvider,
  AuthSnapshot,
  AuthTokens,
  ClockReading,
  CredentialTransitionKind,
  LoginExchangeResponse
} from './types'

const LOGIN_REQUEST_MAX_AGE_MS = 600_000
const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

type PendingLogin = {
  readonly attemptId: string
  readonly provider: AuthProvider
  readonly verifier: string
  readonly generation: number
  readonly startedAt: ClockReading
  requestId: string | null
  expiresAt: string | null
  expiresAtMs: number | null
  stage: 'starting' | 'waiting' | 'exchanging'
  rejectedFingerprint: string | null
  exchangeFingerprint: string | null
  exchangePromise: Promise<void> | null
  controller: AbortController
  cancelExpiry: (() => void) | null
}

type SessionCredential = AuthTokens &
  Readonly<{
    accessTokenExpiresAtMs: number
  }>

type SnapshotState = Readonly<{
  phase: AuthPhase
  login: AuthSnapshot['login']
  user: AuthSnapshot['user']
  entry: AuthSnapshot['entry']
  notice: AuthNotice | null
}>

function isAuthProvider(value: unknown): value is AuthProvider {
  const isGoogle = value === 'google'
  const isDiscord = value === 'discord'
  const isProvider = isGoogle || isDiscord

  return isProvider
}

function isCanonicalUuid(value: unknown): value is string {
  const isString = typeof value === 'string'
  const isUuid = isString && UUID_PATTERN.test(value)

  return isUuid
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('base64url')
}

function sessionCredential(tokens: AuthTokens): SessionCredential {
  return {
    ...tokens,
    accessTokenExpiresAtMs: Date.parse(tokens.accessTokenExpiresAt)
  }
}

export function createAuthCoordinator(dependencies: AuthCoordinatorDependencies): AuthCoordinator {
  validateApiOrigin(dependencies.apiOrigin)
  validateReturnTarget(dependencies.returnTarget)

  const providers = [...dependencies.providers]
  const hasOnlyProviders = providers.every(isAuthProvider)
  const hasNoDuplicateProviders = new Set(providers).size === providers.length
  const hasValidProviders = hasOnlyProviders && hasNoDuplicateProviders
  const runId = dependencies.entropy.uuid()
  const hasValidRunId = isCanonicalUuid(runId)
  if (!hasValidProviders || !hasValidRunId) {
    throw new Error('Auth coordinator configuration is invalid.')
  }

  let revision = 0
  let generation = 0
  let state: SnapshotState = {
    phase: 'restoring',
    login: null,
    user: null,
    entry: null,
    notice: null
  }
  let pending: PendingLogin | null = null
  let credential: SessionCredential | null = null
  let knownRefreshToken: string | null = null
  let blockedMode: 'inspect' | 'cleanup' | null = null
  let startPromise: Promise<AuthSnapshot> | null = null
  let activeWriter: Promise<void> | null = null
  let activeCredentialHttpStarted = false
  let refreshFlight: Readonly<{ generation: number; promise: Promise<AuthAuthorization> }> | null =
    null
  let logoutFlight: Promise<AuthCommandResult> | null = null
  let verificationController: AbortController | null = null
  let disposalFlight: Readonly<{ refreshToken: string; promise: Promise<boolean> }> | null = null
  let lateDisposalUnconfirmed = false
  const listeners = new Set<(snapshot: AuthSnapshot) => void>()

  function snapshot(): AuthSnapshot {
    return {
      runId,
      revision,
      phase: state.phase,
      providers: [...providers],
      login:
        state.login == null
          ? null
          : {
              attemptId: state.login.attemptId,
              provider: state.login.provider,
              expiresAt: state.login.expiresAt
            },
      user: state.user == null ? null : { nickname: state.user.nickname },
      entry: state.entry,
      notice: state.notice
    }
  }

  function publish(next: SnapshotState): AuthSnapshot {
    const canIncrement = revision < Number.MAX_SAFE_INTEGER
    if (!canIncrement) {
      throw new Error('Auth snapshot revision is exhausted.')
    }
    revision += 1
    state = next
    const current = snapshot()
    for (const listener of listeners) {
      try {
        listener(current)
      } catch {
        // Snapshot consumer 실패가 main의 credential state 전이를 되돌리지 않게 한다.
      }
    }
    return current
  }

  function success(current = snapshot()): AuthCommandResult {
    return { ok: true, snapshot: current }
  }

  function failure(code: AuthCommandError): AuthCommandResult {
    return { ok: false, error: { code }, snapshot: snapshot() }
  }

  function pendingSnapshot(value: PendingLogin): NonNullable<AuthSnapshot['login']> {
    return {
      attemptId: value.attemptId,
      provider: value.provider,
      expiresAt: value.expiresAt
    }
  }

  function isCurrentPending(value: PendingLogin): boolean {
    const hasSamePending = pending === value
    const hasSameGeneration = generation === value.generation
    const isCurrent = hasSamePending && hasSameGeneration

    return isCurrent
  }

  function pendingExpired(value: PendingLogin, checkedAt: ClockReading): boolean {
    const isWallClockReversed = checkedAt.wallMs < value.startedAt.wallMs
    const isMonotonicReversed = checkedAt.monotonicMs < value.startedAt.monotonicMs
    const hasReachedMonotonicLimit =
      checkedAt.monotonicMs - value.startedAt.monotonicMs >= LOGIN_REQUEST_MAX_AGE_MS
    const expiresAtMs = value.expiresAtMs
    const hasServerExpiry = expiresAtMs != null
    const hasReachedServerExpiry = hasServerExpiry && checkedAt.wallMs >= expiresAtMs
    const isExpired =
      value.startedAt.discontinuous ||
      checkedAt.discontinuous ||
      isWallClockReversed ||
      isMonotonicReversed ||
      hasReachedMonotonicLimit ||
      hasReachedServerExpiry

    return isExpired
  }

  function keepPendingFresh(value: PendingLogin): boolean {
    if (!isCurrentPending(value)) {
      return false
    }
    const checkedAt = dependencies.clock.read()
    const isExpired = pendingExpired(value, checkedAt)
    if (isExpired) {
      expirePending(value)
      return false
    }
    return true
  }

  function clearPendingReference(value: PendingLogin): void {
    value.cancelExpiry?.()
    value.cancelExpiry = null
    value.controller.abort()
    if (pending === value) {
      pending = null
    }
  }

  function expirePending(value: PendingLogin): void {
    if (!isCurrentPending(value)) {
      return
    }
    generation += 1
    clearPendingReference(value)
    publish({
      phase: 'signedOut',
      login: null,
      user: null,
      entry: null,
      notice: 'LOGIN_EXPIRED'
    })
  }

  function scheduleExpiry(value: PendingLogin): void {
    value.cancelExpiry?.()
    const checkedAt = dependencies.clock.read()
    if (pendingExpired(value, checkedAt)) {
      expirePending(value)
      return
    }

    const monotonicRemaining =
      value.startedAt.monotonicMs + LOGIN_REQUEST_MAX_AGE_MS - checkedAt.monotonicMs
    const wallRemaining =
      value.expiresAtMs == null ? monotonicRemaining : value.expiresAtMs - checkedAt.wallMs
    const delayMs = Math.max(0, Math.min(monotonicRemaining, wallRemaining))
    value.cancelExpiry = dependencies.clock.schedule(delayMs, () => {
      if (!isCurrentPending(value)) {
        return
      }
      const firedAt = dependencies.clock.read()
      if (pendingExpired(value, firedAt)) {
        expirePending(value)
      } else {
        scheduleExpiry(value)
      }
    })
  }

  function storageBlocked(
    notice: 'SECURE_STORAGE_UNAVAILABLE' | 'LOCAL_CLEAR_UNCONFIRMED' | 'TOKEN_SAVE_FAILED',
    mode: 'inspect' | 'cleanup'
  ): void {
    blockedMode = mode
    credential = null
    knownRefreshToken = null
    disposalFlight = null
    if (pending != null) {
      clearPendingReference(pending)
    }
    publish({
      phase: 'storageBlocked',
      login: null,
      user: null,
      entry: null,
      notice
    })
  }

  function disposeKnownRefresh(refreshToken: string): Promise<boolean> {
    const existing = disposalFlight
    const canJoin = existing != null && existing.refreshToken === refreshToken
    if (canJoin) {
      return existing.promise
    }

    const promise = (async () => {
      try {
        await dependencies.http.logout(refreshToken, new AbortController().signal)
        return true
      } catch {
        const hasConcurrentLogout = logoutFlight != null
        // Known current/consumed token이 있으면 logout이 그 서버 결과로 같은 session 폐기를 판단한다.
        const hasKnownLogoutCredential = knownRefreshToken != null
        const needsLateDisposalConfirmation = hasConcurrentLogout && !hasKnownLogoutCredential
        if (needsLateDisposalConfirmation) {
          lateDisposalUnconfirmed = true
        }
        return false
      }
    })()
    disposalFlight = { refreshToken, promise }
    return promise
  }

  async function clearLocal(): Promise<boolean> {
    try {
      const result = await clearCredential(dependencies.store)
      return result === 'cleared'
    } catch {
      return false
    }
  }

  async function prepareLocalClear(): Promise<boolean> {
    try {
      const prepared = await prepareCredentialTransition(dependencies.store, 'clear')
      return prepared === 'established'
    } catch {
      return false
    }
  }

  async function finishLocalClear(): Promise<boolean> {
    try {
      const cleared = await finishCredentialClear(dependencies.store)
      return cleared === 'cleared'
    } catch {
      return false
    }
  }

  async function cleanupAfterInvalidation(
    notice: AuthNotice,
    cleanupGeneration: number
  ): Promise<void> {
    const cleared = await clearLocal()
    const isCurrentCleanup = generation === cleanupGeneration
    if (!isCurrentCleanup) {
      return
    }
    credential = null
    knownRefreshToken = null
    disposalFlight = null
    if (!cleared) {
      storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
      return
    }
    publish({ phase: 'signedOut', login: null, user: null, entry: null, notice })
  }

  async function handleStaleTransition(refreshToken?: string): Promise<void> {
    if (refreshToken != null) {
      await disposeKnownRefresh(refreshToken)
    }
    const isLogoutCleaning = logoutFlight != null
    if (isLogoutCleaning) {
      return
    }
    const cleared = await clearLocal()
    if (!cleared) {
      storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
    } else {
      disposalFlight = null
    }
  }

  async function prepareTransition(
    kind: CredentialTransitionKind,
    operationGeneration: number
  ): Promise<boolean> {
    let prepared: Awaited<ReturnType<typeof prepareCredentialTransition>>
    try {
      prepared = await prepareCredentialTransition(dependencies.store, kind)
    } catch {
      prepared = 'unconfirmed'
    }
    const isCurrentGeneration = generation === operationGeneration
    if (!isCurrentGeneration) {
      if (prepared === 'established') {
        await handleStaleTransition()
      }
      return false
    }
    if (prepared === 'established') {
      return true
    }

    generation += 1
    const notice = prepared === 'failed' ? 'SECURE_STORAGE_UNAVAILABLE' : 'LOCAL_CLEAR_UNCONFIRMED'
    storageBlocked(notice, prepared === 'failed' ? 'inspect' : 'cleanup')
    return false
  }

  async function commitTokens(
    tokens: AuthTokens,
    kind: CredentialTransitionKind,
    operationGeneration: number,
    isOperationFresh: () => boolean = () => generation === operationGeneration
  ): Promise<boolean> {
    let credentialCommit: Awaited<ReturnType<typeof dependencies.store.commitCredential>>
    try {
      credentialCommit = await dependencies.store.commitCredential(tokens.refreshToken)
    } catch {
      credentialCommit = 'unknown'
    }
    const isFreshAfterCommit = isOperationFresh()
    if (!isFreshAfterCommit) {
      const logoutOwnsRefreshCleanup = kind === 'refresh' && logoutFlight != null
      await handleStaleTransition(logoutOwnsRefreshCleanup ? undefined : tokens.refreshToken)
      return false
    }
    const isCredentialCommitted = credentialCommit === 'confirmed'
    if (!isCredentialCommitted) {
      await disposeKnownRefresh(tokens.refreshToken)
      const isCurrentAfterDisposal = generation === operationGeneration
      if (!isCurrentAfterDisposal) {
        await handleStaleTransition()
        return false
      }
      generation += 1
      storageBlocked('TOKEN_SAVE_FAILED', 'cleanup')
      return false
    }

    let finalized: Awaited<ReturnType<typeof finalizeCredentialTransition>>
    try {
      finalized = await finalizeCredentialTransition(dependencies.store, kind)
    } catch {
      finalized = 'clear-unconfirmed'
    }
    const isFreshAfterFinalize = isOperationFresh()
    if (!isFreshAfterFinalize) {
      const logoutOwnsRefreshCleanup = kind === 'refresh' && logoutFlight != null
      let hasDurableMarker = finalized === 'save-failed'
      if (finalized === 'committed') {
        try {
          hasDurableMarker = (await dependencies.store.reestablishTransition(kind)) === 'confirmed'
        } catch {
          hasDurableMarker = false
        }
      }
      if (!hasDurableMarker) {
        const isExplicitLogout = logoutFlight != null
        if (!isExplicitLogout) {
          storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
        }
        if (!logoutOwnsRefreshCleanup) {
          await disposeKnownRefresh(tokens.refreshToken)
        }
        return false
      }
      await handleStaleTransition(logoutOwnsRefreshCleanup ? undefined : tokens.refreshToken)
      return false
    }
    if (finalized === 'committed') {
      credential = sessionCredential(tokens)
      knownRefreshToken = tokens.refreshToken
      disposalFlight = null
      return true
    }

    await disposeKnownRefresh(tokens.refreshToken)
    const isCurrentAfterDisposal = generation === operationGeneration
    if (!isCurrentAfterDisposal) {
      await handleStaleTransition()
      return false
    }
    generation += 1
    const notice = finalized === 'save-failed' ? 'TOKEN_SAVE_FAILED' : 'LOCAL_CLEAR_UNCONFIRMED'
    storageBlocked(notice, 'cleanup')
    return false
  }

  function finishPendingFailure(value: PendingLogin, notice: AuthNotice): void {
    if (!isCurrentPending(value)) {
      return
    }
    generation += 1
    clearPendingReference(value)
    publish({ phase: 'signedOut', login: null, user: null, entry: null, notice })
  }

  function loginRequestNotice(error: unknown): AuthNotice {
    const isNetwork = error instanceof AuthHttpFailure && error.code === 'network'
    const isUnavailable = error instanceof AuthHttpFailure && error.code === 'unavailable'
    if (isNetwork) {
      return 'NETWORK_UNAVAILABLE'
    }
    if (isUnavailable) {
      return 'AUTH_SERVICE_UNAVAILABLE'
    }
    return 'LOGIN_RESTART_REQUIRED'
  }

  async function prepareLoginStorage(value: PendingLogin): Promise<boolean> {
    let inspection
    try {
      inspection = await dependencies.store.inspect()
    } catch {
      inspection = { status: 'unavailable' as const }
    }
    if (!isCurrentPending(value)) {
      return false
    }
    if (inspection.status === 'empty') {
      return true
    }
    if (inspection.status === 'recovery-required') {
      let cleared = false
      await startWriter(async () => {
        cleared = await clearLocal()
      })
      if (!isCurrentPending(value)) {
        return false
      }
      if (cleared) {
        return true
      }
      generation += 1
      storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
      return false
    }

    generation += 1
    storageBlocked('SECURE_STORAGE_UNAVAILABLE', 'inspect')
    return false
  }

  async function continueLoginStart(value: PendingLogin, challenge: string): Promise<void> {
    const isStorageReady = await prepareLoginStorage(value)
    if (!isStorageReady) {
      return
    }

    let created
    try {
      created = await dependencies.http.createLoginRequest(
        {
          provider: value.provider,
          clientId: 'desktop',
          codeChallenge: challenge,
          codeChallengeMethod: 'S256'
        },
        value.controller.signal
      )
    } catch (error) {
      finishPendingFailure(value, loginRequestNotice(error))
      return
    }
    if (!isCurrentPending(value)) {
      return
    }

    value.requestId = created.requestId
    value.expiresAt = created.expiresAt
    value.expiresAtMs = Date.parse(created.expiresAt)
    value.stage = 'waiting'
    const checkedAt = dependencies.clock.read()
    if (pendingExpired(value, checkedAt)) {
      expirePending(value)
      return
    }
    scheduleExpiry(value)
    if (!isCurrentPending(value)) {
      return
    }
    publish({
      phase: 'waitingBrowser',
      login: pendingSnapshot(value),
      user: null,
      entry: null,
      notice: null
    })

    if (!isCurrentPending(value)) {
      return
    }
    try {
      await dependencies.browser.open(created.browserUrl)
    } catch {
      finishPendingFailure(value, 'BROWSER_OPEN_FAILED')
    }
  }

  async function recoverRejectedExchange(value: PendingLogin): Promise<void> {
    const cleared = await clearLocal()
    if (!isCurrentPending(value)) {
      return
    }
    if (!cleared) {
      generation += 1
      storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
      return
    }
    const checkedAt = dependencies.clock.read()
    if (pendingExpired(value, checkedAt)) {
      expirePending(value)
      return
    }

    value.stage = 'waiting'
    value.exchangeFingerprint = null
    publish({
      phase: 'waitingBrowser',
      login: pendingSnapshot(value),
      user: null,
      entry: null,
      notice: 'LOGIN_RETURN_INVALID'
    })
  }

  async function exchangeLogin(
    value: PendingLogin,
    requestId: string,
    code: string
  ): Promise<void> {
    const operationGeneration = value.generation
    const prepared = await prepareTransition('exchange', operationGeneration)
    if (!prepared) {
      return
    }
    if (!keepPendingFresh(value)) {
      await handleStaleTransition()
      return
    }

    let exchanged: LoginExchangeResponse
    try {
      activeCredentialHttpStarted = true
      exchanged = await dependencies.http.exchange(
        {
          requestId,
          clientId: 'desktop',
          code,
          codeVerifier: value.verifier
        },
        value.controller.signal
      )
    } catch (error) {
      if (!keepPendingFresh(value)) {
        await handleStaleTransition()
        return
      }
      const isRejected = error instanceof AuthHttpFailure && error.code === 'exchange-invalid'
      if (isRejected) {
        value.rejectedFingerprint = fingerprint(code)
        await recoverRejectedExchange(value)
        return
      }

      const cleared = await clearLocal()
      if (!isCurrentPending(value)) {
        return
      }
      if (!cleared) {
        generation += 1
        storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
        return
      }
      finishPendingFailure(value, 'LOGIN_RESTART_REQUIRED')
      return
    }

    if (!keepPendingFresh(value)) {
      await handleStaleTransition(exchanged.refreshToken)
      return
    }
    const committed = await commitTokens(exchanged, 'exchange', operationGeneration, () =>
      keepPendingFresh(value)
    )
    if (!committed || !isCurrentPending(value)) {
      return
    }

    clearPendingReference(value)
    blockedMode = null
    publish({
      phase: 'signedIn',
      login: null,
      user: { nickname: exchanged.user.nickname },
      entry: exchanged.isNewUser ? 'welcome' : 'home',
      notice: null
    })
  }

  function beginLogin(provider: unknown): Promise<AuthCommandResult> {
    if (!isAuthProvider(provider)) {
      return Promise.resolve(failure('INVALID_AUTH_COMMAND'))
    }
    const isEnabled = providers.includes(provider)
    if (!isEnabled) {
      return Promise.resolve(failure('AUTH_NOT_ALLOWED'))
    }
    const hasActiveOperation = activeWriter != null || logoutFlight != null
    const isSignedOut = state.phase === 'signedOut'
    if (hasActiveOperation || !isSignedOut) {
      return Promise.resolve(failure('AUTH_BUSY'))
    }

    generation += 1
    const attemptId = dependencies.entropy.uuid()
    const isValidAttemptId = isCanonicalUuid(attemptId)
    if (!isValidAttemptId) {
      return Promise.resolve(failure('AUTH_OPERATION_FAILED'))
    }
    let pkce
    try {
      pkce = createPkce(dependencies.entropy.bytes)
    } catch {
      return Promise.resolve(failure('AUTH_OPERATION_FAILED'))
    }
    const startedAt = dependencies.clock.read()
    const value: PendingLogin = {
      attemptId,
      provider,
      verifier: pkce.verifier,
      generation,
      startedAt,
      requestId: null,
      expiresAt: null,
      expiresAtMs: null,
      stage: 'starting',
      rejectedFingerprint: null,
      exchangeFingerprint: null,
      exchangePromise: null,
      controller: new AbortController(),
      cancelExpiry: null
    }
    pending = value
    scheduleExpiry(value)
    if (!isCurrentPending(value)) {
      return Promise.resolve(success())
    }
    const starting = publish({
      phase: 'startingLogin',
      login: pendingSnapshot(value),
      user: null,
      entry: null,
      notice: null
    })
    void continueLoginStart(value, pkce.challenge)

    return Promise.resolve(success(starting))
  }

  function cancelLogin(attemptId: unknown): Promise<AuthCommandResult> {
    if (!isCanonicalUuid(attemptId)) {
      return Promise.resolve(failure('INVALID_AUTH_COMMAND'))
    }
    const value = pending
    const hasCurrentPending = value != null
    const hasSameAttempt = hasCurrentPending && value.attemptId === attemptId
    if (!hasSameAttempt) {
      return Promise.resolve(failure('STALE_ATTEMPT'))
    }

    generation += 1
    clearPendingReference(value)
    const cancelled = publish({
      phase: 'signedOut',
      login: null,
      user: null,
      entry: null,
      notice: 'LOGIN_CANCELLED'
    })
    return Promise.resolve(success(cancelled))
  }

  function handleReturnUrl(raw: unknown): Promise<void> {
    let parsed: Readonly<{ code: string }>
    try {
      parsed = parseReturnUrl(raw, dependencies.returnTarget)
    } catch {
      return Promise.resolve()
    }

    const value = pending
    if (value == null) {
      const needsNewLogin = state.phase === 'signedOut'
      if (needsNewLogin) {
        publish({
          phase: 'signedOut',
          login: null,
          user: null,
          entry: null,
          notice: 'LOGIN_RESTART_REQUIRED'
        })
      }
      return Promise.resolve()
    }
    const checkedAt = dependencies.clock.read()
    if (pendingExpired(value, checkedAt)) {
      expirePending(value)
      return Promise.resolve()
    }
    const codeFingerprint = fingerprint(parsed.code)
    const wasRejected = value.rejectedFingerprint === codeFingerprint
    if (wasRejected) {
      return Promise.resolve()
    }
    const isExchangeInFlight = value.stage === 'exchanging'
    if (isExchangeInFlight) {
      const isSameExchange = value.exchangeFingerprint === codeFingerprint
      return isSameExchange && value.exchangePromise != null
        ? value.exchangePromise
        : Promise.resolve()
    }
    const requestId = value.requestId
    const canExchange = value.stage === 'waiting' && requestId != null
    if (!canExchange) {
      return Promise.resolve()
    }

    value.stage = 'exchanging'
    value.exchangeFingerprint = codeFingerprint
    value.controller = new AbortController()
    publish({
      phase: 'exchanging',
      login: pendingSnapshot(value),
      user: null,
      entry: null,
      notice: null
    })
    const exchange = exchangeLogin(value, requestId, parsed.code)
    value.exchangePromise = exchange
    const writer = exchange.then(() => undefined)
    activeCredentialHttpStarted = false
    activeWriter = writer
    const clearWriter = (): void => {
      if (activeWriter === writer) {
        activeWriter = null
        activeCredentialHttpStarted = false
      }
    }
    void writer.then(clearWriter, clearWriter)
    return exchange
  }

  async function rotateCredential(
    refreshToken: string,
    operationGeneration: number
  ): Promise<SessionCredential | null> {
    const prepared = await prepareTransition('refresh', operationGeneration)
    if (!prepared) {
      return null
    }

    let tokens: AuthTokens
    try {
      activeCredentialHttpStarted = true
      tokens = await dependencies.http.refresh(refreshToken, new AbortController().signal)
    } catch (error) {
      const isCurrent = generation === operationGeneration
      if (!isCurrent) {
        return null
      }

      const wasNotSent =
        error instanceof AuthHttpFailure &&
        error.code === 'network' &&
        error.transmission === 'not-sent'
      if (wasNotSent) {
        let removed = false
        try {
          removed = (await dependencies.store.removeTransition()) === 'confirmed'
        } catch {
          removed = false
        }
        const isCurrentAfterRemoval = generation === operationGeneration
        if (!isCurrentAfterRemoval) {
          await handleStaleTransition()
          return null
        }
        if (removed) {
          knownRefreshToken = refreshToken
          publish({
            phase: 'restorePaused',
            login: null,
            user: null,
            entry: null,
            notice: 'NETWORK_UNAVAILABLE'
          })
          return null
        }
      }

      generation += 1
      const cleanupGeneration = generation
      credential = null
      publish({ phase: 'signingOut', login: null, user: null, entry: null, notice: null })
      await disposeKnownRefresh(refreshToken)
      const canClear = generation === cleanupGeneration
      if (canClear) {
        await cleanupAfterInvalidation('REAUTH_REQUIRED', cleanupGeneration)
      }
      return null
    }

    const isCurrent = generation === operationGeneration
    if (!isCurrent) {
      return null
    }
    const committed = await commitTokens(tokens, 'refresh', operationGeneration)
    return committed ? credential : null
  }

  function startWriter(operation: () => Promise<void>): Promise<void> {
    activeCredentialHttpStarted = false
    const writer = operation()
    activeWriter = writer
    const clearWriter = (): void => {
      if (activeWriter === writer) {
        activeWriter = null
        activeCredentialHttpStarted = false
      }
    }
    void writer.then(clearWriter, clearWriter)
    return writer
  }

  async function verifyRestoredUser(operationGeneration: number): Promise<void> {
    const currentCredential = credential
    const isCurrent = generation === operationGeneration
    if (!isCurrent || currentCredential == null) {
      return
    }

    const controller = new AbortController()
    verificationController = controller
    try {
      const response = await dependencies.http.me(currentCredential.accessToken, controller.signal)
      const canPublish = generation === operationGeneration && credential === currentCredential
      if (!canPublish) {
        return
      }
      blockedMode = null
      publish({
        phase: 'signedIn',
        login: null,
        user: { nickname: response.user.nickname },
        entry: 'home',
        notice: null
      })
    } catch (error) {
      const isStillCurrent = generation === operationGeneration
      if (!isStillCurrent) {
        return
      }
      const needsAuthentication =
        error instanceof AuthHttpFailure && error.code === 'authentication-required'
      if (needsAuthentication) {
        generation += 1
        const cleanupGeneration = generation
        await startWriter(async () => {
          await disposeKnownRefresh(currentCredential.refreshToken)
          const canClear = generation === cleanupGeneration
          if (canClear) {
            await cleanupAfterInvalidation('REAUTH_REQUIRED', cleanupGeneration)
          }
        })
        return
      }
      const isNetwork = error instanceof AuthHttpFailure && error.code === 'network'
      publish({
        phase: 'restorePaused',
        login: null,
        user: null,
        entry: null,
        notice: isNetwork ? 'NETWORK_UNAVAILABLE' : 'AUTH_SERVICE_UNAVAILABLE'
      })
    } finally {
      if (verificationController === controller) {
        verificationController = null
      }
    }
  }

  async function restoreReadyCredential(
    refreshToken: string,
    operationGeneration: number
  ): Promise<void> {
    const isCurrent = generation === operationGeneration
    if (!isCurrent) {
      return
    }
    knownRefreshToken = refreshToken
    await startWriter(async () => {
      await rotateCredential(refreshToken, operationGeneration)
    })
    const canVerify = generation === operationGeneration && credential != null
    if (canVerify) {
      await verifyRestoredUser(operationGeneration)
    }
  }

  async function restoreFromStore(operationGeneration: number): Promise<AuthSnapshot> {
    let inspection
    try {
      inspection = await dependencies.store.inspect()
    } catch {
      inspection = { status: 'unavailable' as const }
    }
    const isCurrent = generation === operationGeneration
    if (!isCurrent) {
      return snapshot()
    }

    if (inspection.status === 'unavailable') {
      storageBlocked('SECURE_STORAGE_UNAVAILABLE', 'inspect')
      return snapshot()
    }
    if (inspection.status === 'empty') {
      blockedMode = null
      publish({ phase: 'signedOut', login: null, user: null, entry: null, notice: null })
      return snapshot()
    }
    if (inspection.status === 'recovery-required') {
      let cleared = false
      await startWriter(async () => {
        cleared = await clearLocal()
      })
      const canPublish = generation === operationGeneration
      if (!canPublish) {
        return snapshot()
      }
      if (cleared) {
        blockedMode = null
        publish({
          phase: 'signedOut',
          login: null,
          user: null,
          entry: null,
          notice: 'REAUTH_REQUIRED'
        })
      } else {
        storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
      }
      return snapshot()
    }

    await restoreReadyCredential(inspection.refreshToken, operationGeneration)
    return snapshot()
  }

  function start(): Promise<AuthSnapshot> {
    if (startPromise == null) {
      startPromise = restoreFromStore(generation)
    }
    return startPromise
  }

  function refreshAuthorization(): Promise<AuthAuthorization> {
    const currentCredential = credential
    if (currentCredential == null || state.phase !== 'signedIn') {
      return Promise.resolve({ status: 'unavailable' })
    }
    const operationGeneration = generation
    const existing = refreshFlight
    const canJoin = existing != null && existing.generation === operationGeneration
    if (canJoin) {
      return existing.promise
    }

    const promise = (async (): Promise<AuthAuthorization> => {
      await startWriter(async () => {
        await rotateCredential(currentCredential.refreshToken, operationGeneration)
      })
      const refreshedCredential = credential
      const canAuthorize =
        generation === operationGeneration &&
        state.phase === 'signedIn' &&
        refreshedCredential != null
      if (!canAuthorize) {
        return { status: 'unavailable' }
      }
      return {
        status: 'available',
        accessToken: refreshedCredential.accessToken,
        generation: operationGeneration
      }
    })()
    refreshFlight = { generation: operationGeneration, promise }
    const clearRefresh = (): void => {
      if (refreshFlight?.promise === promise) {
        refreshFlight = null
      }
    }
    void promise.then(clearRefresh, clearRefresh)
    return promise
  }

  function authorization(): Promise<AuthAuthorization> {
    const currentCredential = credential
    const isSignedIn = state.phase === 'signedIn'
    if (!isSignedIn || currentCredential == null) {
      return Promise.resolve({ status: 'unavailable' })
    }
    const checkedAt = dependencies.clock.read()
    const isClockUsable = !checkedAt.discontinuous
    const isAccessCurrent = checkedAt.wallMs < currentCredential.accessTokenExpiresAtMs
    const canUseAccess = isClockUsable && isAccessCurrent
    if (canUseAccess) {
      return Promise.resolve({
        status: 'available',
        accessToken: currentCredential.accessToken,
        generation
      })
    }

    return refreshAuthorization()
  }

  async function retry(): Promise<AuthCommandResult> {
    const isRestorePaused = state.phase === 'restorePaused'
    const isStorageBlocked = state.phase === 'storageBlocked'
    if (!isRestorePaused && !isStorageBlocked) {
      return failure('AUTH_NOT_ALLOWED')
    }
    const hasActiveOperation = activeWriter != null || logoutFlight != null
    if (hasActiveOperation) {
      return failure('AUTH_BUSY')
    }

    if (isRestorePaused) {
      const currentCredential = credential
      if (currentCredential == null) {
        const refreshToken = knownRefreshToken
        if (refreshToken == null) {
          return failure('AUTH_OPERATION_FAILED')
        }
        publish({ phase: 'restoring', login: null, user: null, entry: null, notice: null })
        await restoreReadyCredential(refreshToken, generation)
        return success()
      }
      publish({ phase: 'restoring', login: null, user: null, entry: null, notice: null })
      const checkedAt = dependencies.clock.read()
      const canUseAccess =
        !checkedAt.discontinuous && checkedAt.wallMs < currentCredential.accessTokenExpiresAtMs
      const operationGeneration = generation
      if (!canUseAccess) {
        await startWriter(async () => {
          await rotateCredential(currentCredential.refreshToken, operationGeneration)
        })
      }
      if (generation === operationGeneration && credential != null) {
        await verifyRestoredUser(operationGeneration)
      }
      return success()
    }

    publish({ phase: 'restoring', login: null, user: null, entry: null, notice: null })
    if (blockedMode === 'cleanup') {
      const operationGeneration = generation
      let inspection
      try {
        inspection = await dependencies.store.inspect()
      } catch {
        inspection = { status: 'unavailable' as const }
      }
      const isCurrent = generation === operationGeneration
      if (!isCurrent) {
        return success()
      }
      if (inspection.status === 'unavailable') {
        storageBlocked('SECURE_STORAGE_UNAVAILABLE', 'cleanup')
        return success()
      }
      if (inspection.status !== 'empty') {
        let cleared = false
        await startWriter(async () => {
          cleared = await clearLocal()
        })
        const canPublish = generation === operationGeneration
        if (!canPublish) {
          return success()
        }
        if (!cleared) {
          storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
          return success()
        }
      }
      blockedMode = null
      publish({
        phase: 'signedOut',
        login: null,
        user: null,
        entry: null,
        notice: 'REAUTH_REQUIRED'
      })
      return success()
    }

    await restoreFromStore(generation)
    return success()
  }

  async function performLogout(): Promise<AuthCommandResult> {
    const value = pending
    generation += 1
    const logoutGeneration = generation
    if (value != null) {
      clearPendingReference(value)
    }
    verificationController?.abort()
    const writer = activeWriter
    const writerDisposal = writer == null ? undefined : disposalFlight?.promise
    const credentialHttpWasStarted = activeCredentialHttpStarted
    const refreshToken = knownRefreshToken
    publish({ phase: 'signingOut', login: null, user: null, entry: null, notice: null })

    let localPrepared = false
    let serverLogout: Promise<boolean>
    const canStartServerImmediately = writer != null && credentialHttpWasStarted
    if (canStartServerImmediately) {
      serverLogout =
        refreshToken == null ? Promise.resolve(true) : disposeKnownRefresh(refreshToken)
      await writer.catch(() => undefined)
      localPrepared = await prepareLocalClear()
    } else {
      if (writer != null) {
        await writer.catch(() => undefined)
      }
      localPrepared = await prepareLocalClear()
      serverLogout =
        refreshToken == null ? Promise.resolve(true) : disposeKnownRefresh(refreshToken)
    }
    const serverConfirmed = await serverLogout
    const writerDisposalResult = await writerDisposal
    const hasWriterDisposalFailure = writerDisposalResult === false
    const hasKnownLogoutCredential = refreshToken != null
    const localConfirmed = localPrepared && (await finishLocalClear())
    credential = null
    knownRefreshToken = null
    disposalFlight = null
    blockedMode = localConfirmed ? null : 'cleanup'
    const isServerConfirmed =
      serverConfirmed &&
      !lateDisposalUnconfirmed &&
      (hasKnownLogoutCredential || !hasWriterDisposalFailure)
    lateDisposalUnconfirmed = false
    const isCurrentLogout = generation === logoutGeneration
    if (!isCurrentLogout) {
      return success()
    }
    if (!localConfirmed) {
      publish({
        phase: 'storageBlocked',
        login: null,
        user: null,
        entry: null,
        notice: 'LOCAL_CLEAR_UNCONFIRMED'
      })
      return success()
    }

    publish({
      phase: 'signedOut',
      login: null,
      user: null,
      entry: null,
      notice: isServerConfirmed ? null : 'LOGOUT_SERVER_UNCONFIRMED'
    })
    return success()
  }

  function logout(): Promise<AuthCommandResult> {
    if (logoutFlight != null) {
      return logoutFlight
    }
    const pendingLogin = pending
    const hasPendingBeforeExchange =
      pendingLogin != null &&
      (pendingLogin.stage === 'starting' || pendingLogin.stage === 'waiting')
    if (hasPendingBeforeExchange) {
      return cancelLogin(pendingLogin.attemptId)
    }
    const isAlreadySignedOut = state.phase === 'signedOut' && activeWriter == null
    if (isAlreadySignedOut) {
      return Promise.resolve(success())
    }

    const operation = performLogout()
    logoutFlight = operation
    const clearLogout = (): void => {
      if (logoutFlight === operation) {
        logoutFlight = null
      }
    }
    void operation.then(clearLogout, clearLogout)
    return operation
  }

  return {
    getSnapshot: snapshot,
    subscribe(listener: (snapshot: AuthSnapshot) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start,
    beginLogin,
    cancelLogin,
    handleReturnUrl,
    retryAuth: retry,
    authorization,
    logout
  }
}
