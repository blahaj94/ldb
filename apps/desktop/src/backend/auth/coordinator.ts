import {
  clearCredential,
  finalizeCredentialTransition,
  finishCredentialClear,
  prepareCredentialTransition
} from './credential-operations'
import { decideLocalCleanup } from './cleanup-result'
import { CredentialSession } from './credential-session'
import type { SessionCredential } from './credential-session'
import { AuthHttpFailure } from './http'
import { createPkce } from './pkce'
import { PendingLogin } from './pending-login'
import type { ClaimedExchange } from './pending-login'
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
  CredentialTransitionKind,
  LoginExchangeResponse
} from './types'

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

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
  const session = new CredentialSession(dependencies.http)
  let blockedMode: 'inspect' | 'cleanup' | null = null
  let startPromise: Promise<AuthSnapshot> | null = null
  let activeWriter: Promise<void> | null = null
  let activeCredentialHttpStarted = false
  let refreshFlight: Readonly<{ generation: number; promise: Promise<AuthAuthorization> }> | null =
    null
  let logoutFlight: Promise<AuthCommandResult> | null = null
  let verificationController: AbortController | null = null
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

  function isCurrentPending(value: PendingLogin): boolean {
    const hasSamePending = pending === value
    const hasSameGeneration = generation === value.generation
    const isCurrent = hasSamePending && hasSameGeneration

    return isCurrent
  }

  function keepPendingFresh(value: PendingLogin): boolean {
    if (!isCurrentPending(value)) {
      return false
    }
    const checkedAt = dependencies.clock.read()
    const isExpired = value.isExpired(checkedAt)
    if (isExpired) {
      expirePending(value)
      return false
    }
    return true
  }

  function clearPendingReference(value: PendingLogin): void {
    value.dispose()
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

  function storageBlocked(
    notice: 'SECURE_STORAGE_UNAVAILABLE' | 'LOCAL_CLEAR_UNCONFIRMED' | 'TOKEN_SAVE_FAILED',
    mode: 'inspect' | 'cleanup'
  ): void {
    blockedMode = mode
    session.discard()
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
    const cleanup = decideLocalCleanup({
      cleared,
      isCurrent: generation === cleanupGeneration,
      logoutOwnsCleanup: logoutFlight != null
    })
    if (cleanup.shouldBlockStorage) {
      storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
    }
    if (!cleanup.canContinue) {
      return
    }
    session.discard()
    publish({ phase: 'signedOut', login: null, user: null, entry: null, notice })
  }

  async function handleStaleTransition(refreshToken?: string): Promise<void> {
    if (refreshToken != null) {
      await session.dispose(refreshToken)
    }
    const isLogoutCleaning = logoutFlight != null
    if (isLogoutCleaning) {
      return
    }
    const cleared = await clearLocal()
    const cleanup = decideLocalCleanup({
      cleared,
      // 이전 token의 정리를 소유한 writer는 명시 logout에만 결과 처리를 인계한다.
      isCurrent: true,
      logoutOwnsCleanup: logoutFlight != null
    })
    if (cleanup.shouldBlockStorage) {
      storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
    }
    if (cleanup.canContinue) {
      session.completeStaleCleanup()
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
      const isUnconfirmed = prepared === 'unconfirmed'
      const isLogoutCleaning = logoutFlight != null
      if (isUnconfirmed && !isLogoutCleaning) {
        storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
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
      await session.dispose(tokens.refreshToken)
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
          await session.dispose(tokens.refreshToken)
        }
        return false
      }
      await handleStaleTransition(logoutOwnsRefreshCleanup ? undefined : tokens.refreshToken)
      return false
    }
    if (finalized === 'committed') {
      session.acceptCommitted(tokens)
      return true
    }

    await session.dispose(tokens.refreshToken)
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
      const cleanup = decideLocalCleanup({
        cleared,
        isCurrent: isCurrentPending(value),
        logoutOwnsCleanup: logoutFlight != null
      })
      if (cleanup.shouldBlockStorage) {
        generation += 1
        storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
      }
      return cleanup.canContinue
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
        value.signal
      )
    } catch (error) {
      finishPendingFailure(value, loginRequestNotice(error))
      return
    }
    if (!isCurrentPending(value)) {
      return
    }

    value.acceptRequest(created)
    const checkedAt = dependencies.clock.read()
    if (value.isExpired(checkedAt)) {
      expirePending(value)
      return
    }
    value.scheduleExpiry()
    if (!isCurrentPending(value)) {
      return
    }
    publish({
      phase: 'waitingBrowser',
      login: value.snapshot(),
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
    const cleanup = decideLocalCleanup({
      cleared,
      isCurrent: isCurrentPending(value),
      logoutOwnsCleanup: logoutFlight != null
    })
    if (cleanup.shouldBlockStorage) {
      generation += 1
      storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
    }
    if (!cleanup.canContinue) {
      return
    }
    const checkedAt = dependencies.clock.read()
    if (value.isExpired(checkedAt)) {
      expirePending(value)
      return
    }

    value.resumeWaiting()
    publish({
      phase: 'waitingBrowser',
      login: value.snapshot(),
      user: null,
      entry: null,
      notice: 'LOGIN_RETURN_INVALID'
    })
  }

  async function exchangeLogin(value: PendingLogin, claim: ClaimedExchange): Promise<void> {
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
      exchanged = await dependencies.http.exchange(claim.input, claim.signal)
    } catch (error) {
      if (!keepPendingFresh(value)) {
        await handleStaleTransition()
        return
      }
      const isRejected = error instanceof AuthHttpFailure && error.code === 'exchange-invalid'
      if (isRejected) {
        value.rejectCode(claim.input.code)
        await recoverRejectedExchange(value)
        return
      }

      const cleared = await clearLocal()
      const cleanup = decideLocalCleanup({
        cleared,
        isCurrent: isCurrentPending(value),
        logoutOwnsCleanup: logoutFlight != null
      })
      if (cleanup.shouldBlockStorage) {
        generation += 1
        storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
      }
      if (cleanup.canContinue) {
        finishPendingFailure(value, 'LOGIN_RESTART_REQUIRED')
      }
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
    const value = new PendingLogin(
      { attemptId, provider, verifier: pkce.verifier, generation, startedAt },
      dependencies.clock,
      expirePending
    )
    pending = value
    value.scheduleExpiry()
    if (!isCurrentPending(value)) {
      return Promise.resolve(success())
    }
    const starting = publish({
      phase: 'startingLogin',
      login: value.snapshot(),
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
    if (value.isExpired(checkedAt)) {
      expirePending(value)
      return Promise.resolve()
    }
    const claim = value.claim(parsed.code)
    const isIgnored = claim.status === 'ignored'
    if (isIgnored) {
      return Promise.resolve()
    }
    const isJoined = claim.status === 'joined'
    if (isJoined) {
      return claim.promise
    }

    publish({
      phase: 'exchanging',
      login: value.snapshot(),
      user: null,
      entry: null,
      notice: null
    })
    if (!isCurrentPending(value)) {
      return Promise.resolve()
    }
    const exchange = exchangeLogin(value, claim)
    value.trackExchange(exchange)
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
          session.retainForRestore(refreshToken)
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
      session.blockAccess()
      publish({ phase: 'signingOut', login: null, user: null, entry: null, notice: null })
      await session.dispose(refreshToken)
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
    return committed ? session.current : null
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
    const currentCredential = session.current
    const isCurrent = generation === operationGeneration
    if (!isCurrent || currentCredential == null) {
      return
    }

    const controller = new AbortController()
    verificationController = controller
    try {
      const response = await dependencies.http.me(currentCredential.accessToken, controller.signal)
      const canPublish = generation === operationGeneration && session.current === currentCredential
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
          await session.dispose(currentCredential.refreshToken)
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
    session.retainForRestore(refreshToken)
    await startWriter(async () => {
      await rotateCredential(refreshToken, operationGeneration)
    })
    const canVerify = generation === operationGeneration && session.current != null
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
      const cleanup = decideLocalCleanup({
        cleared,
        isCurrent: generation === operationGeneration,
        logoutOwnsCleanup: logoutFlight != null
      })
      if (cleanup.shouldBlockStorage) {
        storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
      }
      if (cleanup.canContinue) {
        blockedMode = null
        publish({
          phase: 'signedOut',
          login: null,
          user: null,
          entry: null,
          notice: 'REAUTH_REQUIRED'
        })
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
    const currentCredential = session.current
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
      const refreshedCredential = session.current
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
    const currentCredential = session.current
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

    const operationGeneration = generation
    if (isRestorePaused) {
      const currentCredential = session.current
      if (currentCredential == null) {
        const refreshToken = session.knownRefresh
        if (refreshToken == null) {
          return failure('AUTH_OPERATION_FAILED')
        }
        publish({ phase: 'restoring', login: null, user: null, entry: null, notice: null })
        const canRestore = generation === operationGeneration
        if (!canRestore) {
          return success()
        }
        await restoreReadyCredential(refreshToken, operationGeneration)
        return success()
      }
      publish({ phase: 'restoring', login: null, user: null, entry: null, notice: null })
      const canResume = generation === operationGeneration
      if (!canResume) {
        return success()
      }
      const checkedAt = dependencies.clock.read()
      const canUseAccess =
        !checkedAt.discontinuous && checkedAt.wallMs < currentCredential.accessTokenExpiresAtMs
      if (!canUseAccess) {
        await startWriter(async () => {
          await rotateCredential(currentCredential.refreshToken, operationGeneration)
        })
      }
      if (generation === operationGeneration && session.current != null) {
        await verifyRestoredUser(operationGeneration)
      }
      return success()
    }

    publish({ phase: 'restoring', login: null, user: null, entry: null, notice: null })
    const canRetry = generation === operationGeneration
    if (!canRetry) {
      return success()
    }
    if (blockedMode === 'cleanup') {
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
        const cleanup = decideLocalCleanup({
          cleared,
          isCurrent: generation === operationGeneration,
          logoutOwnsCleanup: logoutFlight != null
        })
        if (cleanup.shouldBlockStorage) {
          storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'cleanup')
        }
        if (!cleanup.canContinue) {
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

    await restoreFromStore(operationGeneration)
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
    const logoutCredentials = session.beginLogout(writer != null)
    const credentialHttpWasStarted = activeCredentialHttpStarted
    const refreshToken = logoutCredentials.refreshToken
    publish({ phase: 'signingOut', login: null, user: null, entry: null, notice: null })

    let localPrepared = false
    let serverLogout: Promise<boolean>
    const canStartServerImmediately = writer != null && credentialHttpWasStarted
    if (canStartServerImmediately) {
      serverLogout = refreshToken == null ? Promise.resolve(true) : session.dispose(refreshToken)
      await writer.catch(() => undefined)
      localPrepared = await prepareLocalClear()
    } else {
      if (writer != null) {
        await writer.catch(() => undefined)
      }
      localPrepared = await prepareLocalClear()
      serverLogout = refreshToken == null ? Promise.resolve(true) : session.dispose(refreshToken)
    }
    const serverConfirmed = await serverLogout
    const writerDisposalResult = await logoutCredentials.writerDisposal
    const localConfirmed = localPrepared && (await finishLocalClear())
    const isServerConfirmed = session.completeLogout(
      logoutCredentials,
      serverConfirmed,
      writerDisposalResult
    )
    blockedMode = localConfirmed ? null : 'cleanup'
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
    const hasPendingBeforeExchange = pendingLogin != null && pendingLogin.isBeforeExchange
    if (hasPendingBeforeExchange) {
      return cancelLogin(pendingLogin.attemptId)
    }
    const isAlreadySignedOut = state.phase === 'signedOut' && activeWriter == null
    if (isAlreadySignedOut) {
      return Promise.resolve(success())
    }

    let resolveLogout!: (result: AuthCommandResult) => void
    let rejectLogout!: (reason: unknown) => void
    const operation = new Promise<AuthCommandResult>((resolve, reject) => {
      resolveLogout = resolve
      rejectLogout = reject
    })
    logoutFlight = operation
    const clearLogout = (): void => {
      if (logoutFlight === operation) {
        logoutFlight = null
      }
    }
    void operation.then(clearLogout, clearLogout)
    void performLogout().then(resolveLogout, rejectLogout)
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
