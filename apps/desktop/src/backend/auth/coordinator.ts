import { AuthState } from './auth-state'
import { selectCredentialRecoveryStep, selectStoreRecoveryStep } from './recovery-plan'
import type { StorageRecoveryPurpose } from './recovery-plan'
import { decideLocalCleanup } from './cleanup-result'
import { CredentialSession } from './credential-session'
import type { CredentialWriter, SessionCredential } from './credential-session'
import { AuthHttpFailure } from './http'
import { createPkce } from './pkce'
import { PendingLogin } from './pending-login'
import type { ClaimedExchange } from './pending-login'
import { parseReturnUrl, validateApiOrigin, validateReturnTarget } from './protocol'
import type {
  AuthAuthorization,
  AuthCommandResult,
  AuthCoordinator,
  AuthCoordinatorDependencies,
  AuthNotice,
  AuthProvider,
  AuthSnapshot,
  AuthTokens,
  CredentialTransitionKind,
  LoginExchangeResponse
} from './types'

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

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

  let generation = 0
  const state = new AuthState(runId, providers)
  let pending: PendingLogin | null = null
  const session = new CredentialSession(dependencies.http, dependencies.store)
  let startPromise: Promise<AuthSnapshot> | null = null
  let logoutFlight: Promise<AuthCommandResult> | null = null
  let verificationController: AbortController | null = null

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
    state.signedOut('LOGIN_EXPIRED')
  }

  function storageBlocked(
    notice: 'SECURE_STORAGE_UNAVAILABLE' | 'LOCAL_CLEAR_UNCONFIRMED' | 'TOKEN_SAVE_FAILED',
    purpose: StorageRecoveryPurpose
  ): void {
    session.discard()
    if (pending != null) {
      clearPendingReference(pending)
    }
    state.storageBlocked(notice, purpose)
  }

  async function cleanupAfterInvalidation(
    notice: AuthNotice,
    cleanupGeneration: number
  ): Promise<void> {
    const cleared = await session.clearLocal()
    const cleanup = decideLocalCleanup({
      cleared,
      isCurrent: generation === cleanupGeneration,
      logoutOwnsCleanup: logoutFlight != null
    })
    if (cleanup.shouldBlockStorage) {
      storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'clear-store')
    }
    if (!cleanup.canContinue) {
      return
    }
    session.discard()
    state.signedOut(notice)
  }

  async function handleStaleTransition(refreshToken?: string): Promise<void> {
    if (refreshToken != null) {
      await session.dispose(refreshToken)
    }
    const isLogoutCleaning = logoutFlight != null
    if (isLogoutCleaning) {
      return
    }
    const cleared = await session.clearLocal()
    const cleanup = decideLocalCleanup({
      cleared,
      // 이전 token의 정리를 소유한 writer는 명시 logout에만 결과 처리를 인계한다.
      isCurrent: true,
      logoutOwnsCleanup: logoutFlight != null
    })
    if (cleanup.shouldBlockStorage) {
      storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'clear-store')
    }
    if (cleanup.canContinue) {
      session.completeStaleCleanup()
    }
  }

  async function prepareTransition(
    kind: CredentialTransitionKind,
    operationGeneration: number
  ): Promise<boolean> {
    let prepared: Awaited<ReturnType<typeof session.prepare>>
    try {
      prepared = await session.prepare(kind)
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
        storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'clear-store')
      }
      return false
    }
    if (prepared === 'established') {
      return true
    }

    generation += 1
    const notice = prepared === 'failed' ? 'SECURE_STORAGE_UNAVAILABLE' : 'LOCAL_CLEAR_UNCONFIRMED'
    storageBlocked(notice, prepared === 'failed' ? 'inspect-store' : 'clear-store')
    return false
  }

  async function commitTokens(
    tokens: AuthTokens,
    kind: CredentialTransitionKind,
    operationGeneration: number,
    isOperationFresh: () => boolean = () => generation === operationGeneration
  ): Promise<boolean> {
    let credentialCommit: Awaited<ReturnType<typeof session.writeCredential>>
    try {
      credentialCommit = await session.writeCredential(tokens.refreshToken)
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
      storageBlocked('TOKEN_SAVE_FAILED', 'clear-store')
      return false
    }

    let finalized: Awaited<ReturnType<typeof session.finalize>>
    try {
      finalized = await session.finalize(kind)
    } catch {
      finalized = 'clear-unconfirmed'
    }
    const isFreshAfterFinalize = isOperationFresh()
    if (!isFreshAfterFinalize) {
      const logoutOwnsRefreshCleanup = kind === 'refresh' && logoutFlight != null
      let hasDurableMarker = finalized === 'save-failed'
      if (finalized === 'committed') {
        try {
          hasDurableMarker = (await session.reestablish(kind)) === 'confirmed'
        } catch {
          hasDurableMarker = false
        }
      }
      if (!hasDurableMarker) {
        const isExplicitLogout = logoutFlight != null
        if (!isExplicitLogout) {
          storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'clear-store')
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
    storageBlocked(notice, 'clear-store')
    return false
  }

  function finishPendingFailure(value: PendingLogin, notice: AuthNotice): void {
    if (!isCurrentPending(value)) {
      return
    }
    generation += 1
    clearPendingReference(value)
    state.signedOut(notice)
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
      await session.runWriter(async () => {
        cleared = await session.clearLocal()
      })
      const cleanup = decideLocalCleanup({
        cleared,
        isCurrent: isCurrentPending(value),
        logoutOwnsCleanup: logoutFlight != null
      })
      if (cleanup.shouldBlockStorage) {
        generation += 1
        storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'clear-store')
      }
      return cleanup.canContinue
    }

    generation += 1
    storageBlocked('SECURE_STORAGE_UNAVAILABLE', 'inspect-store')
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
    state.waitingForBrowser(value.snapshot())

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
    const cleared = await session.clearLocal()
    const cleanup = decideLocalCleanup({
      cleared,
      isCurrent: isCurrentPending(value),
      logoutOwnsCleanup: logoutFlight != null
    })
    if (cleanup.shouldBlockStorage) {
      generation += 1
      storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'clear-store')
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
    state.waitingForBrowser(value.snapshot(), 'LOGIN_RETURN_INVALID')
  }

  async function exchangeLogin(
    value: PendingLogin,
    claim: ClaimedExchange,
    writer: CredentialWriter
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
      exchanged = await session.sendExchange(writer, claim.input, claim.signal)
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

      const cleared = await session.clearLocal()
      const cleanup = decideLocalCleanup({
        cleared,
        isCurrent: isCurrentPending(value),
        logoutOwnsCleanup: logoutFlight != null
      })
      if (cleanup.shouldBlockStorage) {
        generation += 1
        storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'clear-store')
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

    state.signedIn(exchanged.user.nickname, exchanged.isNewUser ? 'welcome' : 'home')
  }

  function beginLogin(provider: unknown): Promise<AuthCommandResult> {
    if (!isAuthProvider(provider)) {
      return Promise.resolve(state.failure('INVALID_AUTH_COMMAND'))
    }
    const isEnabled = providers.includes(provider)
    if (!isEnabled) {
      return Promise.resolve(state.failure('AUTH_NOT_ALLOWED'))
    }
    const hasActiveOperation = session.hasWriter || logoutFlight != null
    const isSignedOut = state.phase === 'signedOut'
    if (hasActiveOperation || !isSignedOut) {
      return Promise.resolve(state.failure('AUTH_BUSY'))
    }

    generation += 1
    const attemptId = dependencies.entropy.uuid()
    const isValidAttemptId = isCanonicalUuid(attemptId)
    if (!isValidAttemptId) {
      return Promise.resolve(state.failure('AUTH_OPERATION_FAILED'))
    }
    let pkce
    try {
      pkce = createPkce(dependencies.entropy.bytes)
    } catch {
      return Promise.resolve(state.failure('AUTH_OPERATION_FAILED'))
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
      return Promise.resolve(state.success())
    }
    const starting = state.loginStarted(value.snapshot())
    void continueLoginStart(value, pkce.challenge)

    return Promise.resolve(state.success(starting))
  }

  function cancelLogin(attemptId: unknown): Promise<AuthCommandResult> {
    if (!isCanonicalUuid(attemptId)) {
      return Promise.resolve(state.failure('INVALID_AUTH_COMMAND'))
    }
    const value = pending
    const hasCurrentPending = value != null
    const hasSameAttempt = hasCurrentPending && value.attemptId === attemptId
    if (!hasSameAttempt) {
      return Promise.resolve(state.failure('STALE_ATTEMPT'))
    }

    generation += 1
    clearPendingReference(value)
    const cancelled = state.signedOut('LOGIN_CANCELLED')
    return Promise.resolve(state.success(cancelled))
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
        state.signedOut('LOGIN_RESTART_REQUIRED')
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

    state.exchangeStarted(value.snapshot())
    if (!isCurrentPending(value)) {
      return Promise.resolve()
    }
    const writer = session.reserveWriter()
    value.trackExchange(writer.completion)
    return writer.execute(() => exchangeLogin(value, claim, writer))
  }

  async function rotateCredential(
    refreshToken: string,
    operationGeneration: number,
    writer: CredentialWriter
  ): Promise<SessionCredential | null> {
    const prepared = await prepareTransition('refresh', operationGeneration)
    if (!prepared) {
      return null
    }

    let tokens: AuthTokens
    try {
      tokens = await session.sendRefresh(writer, refreshToken)
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
          removed = (await session.releaseUnsentTransition()) === 'confirmed'
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
          state.restorePaused('NETWORK_UNAVAILABLE')
          return null
        }
      }

      generation += 1
      const cleanupGeneration = generation
      session.blockAccess()
      state.signingOut()
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

      state.signedIn(response.user.nickname, 'home')
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
        await session.runWriter(async () => {
          await session.dispose(currentCredential.refreshToken)
          const canClear = generation === cleanupGeneration
          if (canClear) {
            await cleanupAfterInvalidation('REAUTH_REQUIRED', cleanupGeneration)
          }
        })
        return
      }
      const isNetwork = error instanceof AuthHttpFailure && error.code === 'network'
      state.restorePaused(isNetwork ? 'NETWORK_UNAVAILABLE' : 'AUTH_SERVICE_UNAVAILABLE')
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
    await session.runWriter(async (writer) => {
      await rotateCredential(refreshToken, operationGeneration, writer)
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
      return state.getSnapshot()
    }

    const step = selectStoreRecoveryStep('inspect-store', inspection.status)
    const isBlocked = step === 'storage-blocked'
    if (isBlocked) {
      storageBlocked('SECURE_STORAGE_UNAVAILABLE', 'inspect-store')
      return state.getSnapshot()
    }
    const isSignedOut = step === 'signed-out'
    if (isSignedOut) {
      state.signedOut()
      return state.getSnapshot()
    }
    const requiresCleanup = step === 'clear-store'
    if (requiresCleanup) {
      let cleared = false
      await session.runWriter(async () => {
        cleared = await session.clearLocal()
      })
      const cleanup = decideLocalCleanup({
        cleared,
        isCurrent: generation === operationGeneration,
        logoutOwnsCleanup: logoutFlight != null
      })
      if (cleanup.shouldBlockStorage) {
        storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'clear-store')
      }
      if (cleanup.canContinue) {
        state.signedOut('REAUTH_REQUIRED')
      }
      return state.getSnapshot()
    }

    const hasReadyCredential = inspection.status === 'ready'
    if (hasReadyCredential) {
      await restoreReadyCredential(inspection.refreshToken, operationGeneration)
    }
    return state.getSnapshot()
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
    return session.shareRefresh(operationGeneration, async () => {
      await session.runWriter(async (writer) => {
        await rotateCredential(currentCredential.refreshToken, operationGeneration, writer)
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
    })
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
      return state.failure('AUTH_NOT_ALLOWED')
    }
    const hasActiveOperation = session.hasWriter || logoutFlight != null
    if (hasActiveOperation) {
      return state.failure('AUTH_BUSY')
    }

    const operationGeneration = generation
    const recoveryPurpose = state.recoveryPurpose
    const resumesCredential = recoveryPurpose === 'resume-credential'
    if (resumesCredential) {
      const currentCredential = session.current
      if (currentCredential == null) {
        const refreshToken = session.knownRefresh
        if (refreshToken == null) {
          return state.failure('AUTH_OPERATION_FAILED')
        }
        state.restoring()
        const canRestore = generation === operationGeneration
        if (!canRestore) {
          return state.success()
        }
        await restoreReadyCredential(refreshToken, operationGeneration)
        return state.success()
      }
      state.restoring()
      const canResume = generation === operationGeneration
      if (!canResume) {
        return state.success()
      }
      const checkedAt = dependencies.clock.read()
      const step = selectCredentialRecoveryStep(checkedAt, currentCredential.accessTokenExpiresAtMs)
      const requiresRefresh = step === 'refresh-credential'
      if (requiresRefresh) {
        await session.runWriter(async (writer) => {
          await rotateCredential(currentCredential.refreshToken, operationGeneration, writer)
        })
      }
      if (generation === operationGeneration && session.current != null) {
        await verifyRestoredUser(operationGeneration)
      }
      return state.success()
    }

    state.restoring()
    const canRetry = generation === operationGeneration
    if (!canRetry) {
      return state.success()
    }
    const requiresCleanup = recoveryPurpose === 'clear-store'
    if (requiresCleanup) {
      let inspection
      try {
        inspection = await dependencies.store.inspect()
      } catch {
        inspection = { status: 'unavailable' as const }
      }
      const isCurrent = generation === operationGeneration
      if (!isCurrent) {
        return state.success()
      }
      const step = selectStoreRecoveryStep(recoveryPurpose, inspection.status)
      const isBlocked = step === 'storage-blocked'
      if (isBlocked) {
        storageBlocked('SECURE_STORAGE_UNAVAILABLE', 'clear-store')
        return state.success()
      }
      const hasRecordsToClear = step === 'clear-store'
      if (hasRecordsToClear) {
        let cleared = false
        await session.runWriter(async () => {
          cleared = await session.clearLocal()
        })
        const cleanup = decideLocalCleanup({
          cleared,
          isCurrent: generation === operationGeneration,
          logoutOwnsCleanup: logoutFlight != null
        })
        if (cleanup.shouldBlockStorage) {
          storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'clear-store')
        }
        if (!cleanup.canContinue) {
          return state.success()
        }
      }

      state.signedOut('REAUTH_REQUIRED')
      return state.success()
    }

    await restoreFromStore(operationGeneration)
    return state.success()
  }

  async function performLogout(): Promise<AuthCommandResult> {
    const value = pending
    generation += 1
    const logoutGeneration = generation
    if (value != null) {
      clearPendingReference(value)
    }
    verificationController?.abort()
    const reservation = session.beginLogout()
    state.signingOut()

    const { localConfirmed, serverConfirmed } = await session.finishLogout(reservation)

    const isCurrentLogout = generation === logoutGeneration
    if (!isCurrentLogout) {
      return state.success()
    }
    if (!localConfirmed) {
      state.storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'clear-store')
      return state.success()
    }

    state.signedOut(serverConfirmed ? null : 'LOGOUT_SERVER_UNCONFIRMED')
    return state.success()
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
    const isAlreadySignedOut = state.phase === 'signedOut' && !session.hasWriter
    if (isAlreadySignedOut) {
      return Promise.resolve(state.success())
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
    getSnapshot: state.getSnapshot,
    subscribe: state.subscribe,
    start,
    beginLogin,
    cancelLogin,
    handleReturnUrl,
    retryAuth: retry,
    authorization,
    logout
  }
}
