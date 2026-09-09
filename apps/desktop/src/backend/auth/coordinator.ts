import { AuthState } from './auth-state'
import { waitForAuthorization } from './authorization-waiter'
import { UserVerification, verificationFailureNotice } from './user-verification'
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
  LoginExchangeResponse,
  RejectedAuthorization
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
  const hasValidConfiguration = hasValidProviders && hasValidRunId
  if (!hasValidConfiguration) {
    throw new Error('Auth coordinator configuration is invalid.')
  }

  let generation = 0
  const state = new AuthState(runId, providers)
  let pending: PendingLogin | null = null
  const session = new CredentialSession(dependencies.http, dependencies.store)
  let startPromise: Promise<AuthSnapshot> | null = null
  let logoutFlight: Promise<AuthCommandResult> | null = null
  const verification = new UserVerification(dependencies.http)

  function isCurrentPending(value: PendingLogin): boolean {
    const hasSamePending = pending === value
    const hasSameGeneration = generation === value.generation
    const isCurrent = hasSamePending && hasSameGeneration

    return isCurrent
  }

  function keepPendingFresh(value: PendingLogin): boolean {
    const isCurrent = isCurrentPending(value)
    if (!isCurrent) {
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
    const isReferencedPending = pending === value
    if (isReferencedPending) {
      pending = null
    }
  }

  function expirePending(value: PendingLogin): void {
    const isCurrent = isCurrentPending(value)
    if (!isCurrent) {
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
    const pendingLogin = pending
    const hasPendingLogin = pendingLogin != null
    if (hasPendingLogin) {
      clearPendingReference(pendingLogin)
    }
    state.storageBlocked(notice, purpose)
  }

  async function cleanupAfterInvalidation(
    notice: AuthNotice,
    cleanupGeneration: number
  ): Promise<void> {
    const cleared = await session.clearLocal()
    const isCurrentCleanup = generation === cleanupGeneration
    const logoutOwnsCleanup = logoutFlight != null
    const cleanup = decideLocalCleanup({
      cleared,
      isCurrent: isCurrentCleanup,
      logoutOwnsCleanup
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
    const hasRefreshToken = refreshToken != null
    if (hasRefreshToken) {
      await session.dispose(refreshToken)
    }
    const isLogoutCleaning = logoutFlight != null
    if (isLogoutCleaning) {
      return
    }
    const cleared = await session.clearLocal()
    const logoutOwnsCleanup = logoutFlight != null
    const cleanup = decideLocalCleanup({
      cleared,
      // 이전 token의 정리를 소유한 writer는 명시 logout에만 결과 처리를 인계한다.
      isCurrent: true,
      logoutOwnsCleanup
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
      const wasEstablished = prepared === 'established'
      if (wasEstablished) {
        await handleStaleTransition()
      }
      const isUnconfirmed = prepared === 'unconfirmed'
      const isLogoutCleaning = logoutFlight != null
      const shouldBlockStorage = isUnconfirmed && !isLogoutCleaning
      if (shouldBlockStorage) {
        storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'clear-store')
      }
      return false
    }
    const isEstablished = prepared === 'established'
    if (isEstablished) {
      return true
    }

    generation += 1
    const didPreparationFail = prepared === 'failed'
    const notice = didPreparationFail ? 'SECURE_STORAGE_UNAVAILABLE' : 'LOCAL_CLEAR_UNCONFIRMED'
    const recoveryPurpose = didPreparationFail ? 'inspect-store' : 'clear-store'
    storageBlocked(notice, recoveryPurpose)
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
      const isRefresh = kind === 'refresh'
      const hasLogoutFlight = logoutFlight != null
      const logoutOwnsRefreshCleanup = isRefresh && hasLogoutFlight
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
      const isRefresh = kind === 'refresh'
      const hasLogoutFlight = logoutFlight != null
      const logoutOwnsRefreshCleanup = isRefresh && hasLogoutFlight
      let hasDurableMarker = finalized === 'save-failed'
      const wasCommitted = finalized === 'committed'
      if (wasCommitted) {
        try {
          const reestablished = await session.reestablish(kind)
          hasDurableMarker = reestablished === 'confirmed'
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
    const isCommitted = finalized === 'committed'
    if (isCommitted) {
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
    const didSaveFail = finalized === 'save-failed'
    const notice = didSaveFail ? 'TOKEN_SAVE_FAILED' : 'LOCAL_CLEAR_UNCONFIRMED'
    storageBlocked(notice, 'clear-store')
    return false
  }

  function finishPendingFailure(value: PendingLogin, notice: AuthNotice): void {
    const isCurrent = isCurrentPending(value)
    if (!isCurrent) {
      return
    }
    generation += 1
    clearPendingReference(value)
    state.signedOut(notice)
  }

  function loginRequestNotice(error: unknown): AuthNotice {
    const isNetworkFailure = error instanceof AuthHttpFailure
    const hasNetworkCode = isNetworkFailure && error.code === 'network'
    const isNetwork = isNetworkFailure && hasNetworkCode
    const isUnavailableFailure = error instanceof AuthHttpFailure
    const hasUnavailableCode = isUnavailableFailure && error.code === 'unavailable'
    const isUnavailable = isUnavailableFailure && hasUnavailableCode
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
    const isCurrent = isCurrentPending(value)
    if (!isCurrent) {
      return false
    }
    const isStoreEmpty = inspection.status === 'empty'
    if (isStoreEmpty) {
      return true
    }
    const requiresRecovery = inspection.status === 'recovery-required'
    if (requiresRecovery) {
      let cleared = false
      await session.runWriter(async () => {
        cleared = await session.clearLocal()
      })
      const isCurrentAfterClear = isCurrentPending(value)
      const logoutOwnsCleanup = logoutFlight != null
      const cleanup = decideLocalCleanup({
        cleared,
        isCurrent: isCurrentAfterClear,
        logoutOwnsCleanup
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
    const isCurrentAfterRequest = isCurrentPending(value)
    if (!isCurrentAfterRequest) {
      return
    }

    value.acceptRequest(created)
    const checkedAt = dependencies.clock.read()
    const isExpired = value.isExpired(checkedAt)
    if (isExpired) {
      expirePending(value)
      return
    }
    value.scheduleExpiry()
    const isCurrentAfterScheduling = isCurrentPending(value)
    if (!isCurrentAfterScheduling) {
      return
    }
    state.waitingForBrowser(value.snapshot())

    const isCurrentBeforeBrowserOpen = isCurrentPending(value)
    if (!isCurrentBeforeBrowserOpen) {
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
    const isCurrentAfterClear = isCurrentPending(value)
    const logoutOwnsCleanup = logoutFlight != null
    const cleanup = decideLocalCleanup({
      cleared,
      isCurrent: isCurrentAfterClear,
      logoutOwnsCleanup
    })
    if (cleanup.shouldBlockStorage) {
      generation += 1
      storageBlocked('LOCAL_CLEAR_UNCONFIRMED', 'clear-store')
    }
    if (!cleanup.canContinue) {
      return
    }
    const checkedAt = dependencies.clock.read()
    const isExpired = value.isExpired(checkedAt)
    if (isExpired) {
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
    const isPendingFreshAfterPreparation = keepPendingFresh(value)
    if (!isPendingFreshAfterPreparation) {
      await handleStaleTransition()
      return
    }

    let exchanged: LoginExchangeResponse
    try {
      exchanged = await session.sendExchange(writer, claim.input, claim.signal)
    } catch (error) {
      const isHttpFailure = error instanceof AuthHttpFailure
      const isRejected = isHttpFailure && error.code === 'exchange-invalid'
      const isNetwork = isHttpFailure && error.code === 'network'
      const isNotSent = isHttpFailure && error.transmission === 'not-sent'
      const isKnownNotSent = isNetwork && isNotSent
      const isServerUnconfirmed = !isRejected && !isKnownNotSent
      if (isServerUnconfirmed) {
        writer.markExchangeUnconfirmed()
      }
      const isPendingFresh = keepPendingFresh(value)
      if (!isPendingFresh) {
        await handleStaleTransition()
        return
      }
      if (isRejected) {
        value.rejectCode(claim.input.code)
        await recoverRejectedExchange(value)
        return
      }

      const cleared = await session.clearLocal()
      const isCurrentAfterClear = isCurrentPending(value)
      const logoutOwnsCleanup = logoutFlight != null
      const cleanup = decideLocalCleanup({
        cleared,
        isCurrent: isCurrentAfterClear,
        logoutOwnsCleanup
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

    const isPendingFreshAfterExchange = keepPendingFresh(value)
    if (!isPendingFreshAfterExchange) {
      await handleStaleTransition(exchanged.refreshToken)
      return
    }
    const committed = await commitTokens(exchanged, 'exchange', operationGeneration, () =>
      keepPendingFresh(value)
    )
    const isCurrentAfterCommit = committed && isCurrentPending(value)
    const canPublishLogin = committed && isCurrentAfterCommit
    if (!canPublishLogin) {
      return
    }

    clearPendingReference(value)

    const entry = exchanged.isNewUser ? 'welcome' : 'home'
    state.signedIn(exchanged.user.nickname, entry)
  }

  function beginLogin(provider: unknown): Promise<AuthCommandResult> {
    const isProvider = isAuthProvider(provider)
    if (!isProvider) {
      return Promise.resolve(state.failure('INVALID_AUTH_COMMAND'))
    }
    const isEnabled = providers.includes(provider)
    if (!isEnabled) {
      return Promise.resolve(state.failure('AUTH_NOT_ALLOWED'))
    }
    const hasWriter = session.hasWriter
    const hasLogoutFlight = logoutFlight != null
    const hasActiveOperation = hasWriter || hasLogoutFlight
    const isSignedOut = state.phase === 'signedOut'
    const canBeginLogin = !hasActiveOperation && isSignedOut
    if (!canBeginLogin) {
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
    const isCurrentAfterScheduling = isCurrentPending(value)
    if (!isCurrentAfterScheduling) {
      return Promise.resolve(state.success())
    }
    const starting = state.loginStarted(value.snapshot())
    void continueLoginStart(value, pkce.challenge)

    return Promise.resolve(state.success(starting))
  }

  function cancelLogin(attemptId: unknown): Promise<AuthCommandResult> {
    const isValidAttemptId = isCanonicalUuid(attemptId)
    if (!isValidAttemptId) {
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
    const hasPendingLogin = value != null
    if (!hasPendingLogin) {
      const needsNewLogin = state.phase === 'signedOut'
      if (needsNewLogin) {
        state.signedOut('LOGIN_RESTART_REQUIRED')
      }
      return Promise.resolve()
    }
    const checkedAt = dependencies.clock.read()
    const isExpired = value.isExpired(checkedAt)
    if (isExpired) {
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
    const isCurrentAfterExchangeStart = isCurrentPending(value)
    if (!isCurrentAfterExchangeStart) {
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

      const isHttpFailure = error instanceof AuthHttpFailure
      const isNetworkFailure = isHttpFailure && error.code === 'network'
      const wasNotSent = isNetworkFailure && error.transmission === 'not-sent'
      if (wasNotSent) {
        let removed = false
        try {
          const releaseOutcome = await session.releaseUnsentTransition()
          removed = releaseOutcome === 'confirmed'
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
    const credential = committed ? session.current : null

    return credential
  }

  async function verifyRestoredUser(operationGeneration: number): Promise<void> {
    const currentCredential = session.current
    const isCurrent = generation === operationGeneration
    const hasCurrentCredential = currentCredential != null
    const canVerify = isCurrent && hasCurrentCredential
    if (!canVerify) {
      return
    }

    const operation = verification.reserve()
    try {
      const response = await verification.send(operation, currentCredential.accessToken)
      const isCurrentAfterVerification = generation === operationGeneration
      const hasSameCredential = isCurrentAfterVerification && session.current === currentCredential
      const canPublish = isCurrentAfterVerification && hasSameCredential
      if (!canPublish) {
        return
      }

      state.signedIn(response.user.nickname, 'home')
    } catch (error) {
      const isStillCurrent = generation === operationGeneration
      if (!isStillCurrent) {
        return
      }
      const notice = verificationFailureNotice(error)
      const needsAuthentication = notice === 'REAUTH_REQUIRED'
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
      state.restorePaused(notice)
    } finally {
      verification.complete(operation)
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
    const isCurrentAfterRotation = generation === operationGeneration
    const hasCurrentCredential = isCurrentAfterRotation && session.current != null
    const canVerify = isCurrentAfterRotation && hasCurrentCredential
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
      const isCurrentAfterClear = generation === operationGeneration
      const logoutOwnsCleanup = logoutFlight != null
      const cleanup = decideLocalCleanup({
        cleared,
        isCurrent: isCurrentAfterClear,
        logoutOwnsCleanup
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
    const existingStart = startPromise
    const hasStartPromise = existingStart != null
    if (hasStartPromise) {
      return existingStart
    }
    const started = restoreFromStore(generation)
    startPromise = started

    return started
  }

  function refreshAuthorization(): Promise<AuthAuthorization> {
    const currentCredential = session.current
    const hasCurrentCredential = currentCredential != null
    const isSignedIn = hasCurrentCredential && state.phase === 'signedIn'
    const canRefresh = hasCurrentCredential && isSignedIn
    if (!canRefresh) {
      return Promise.resolve({ status: 'unavailable' })
    }
    const operationGeneration = generation
    return session.shareRefresh(operationGeneration, async () => {
      await session.runWriter(async (writer) => {
        await rotateCredential(currentCredential.refreshToken, operationGeneration, writer)
      })
      const refreshedCredential = session.current
      const isCurrentGeneration = generation === operationGeneration
      const isStillSignedIn = isCurrentGeneration && state.phase === 'signedIn'
      const hasRefreshedCredential = isStillSignedIn && refreshedCredential != null
      const canAuthorize = isCurrentGeneration && isStillSignedIn && hasRefreshedCredential
      if (!canAuthorize) {
        return { status: 'unavailable' }
      }
      const checkedAt = dependencies.clock.read()
      const step = selectCredentialRecoveryStep(
        checkedAt,
        refreshedCredential.accessTokenExpiresAtMs
      )
      const canUseAccess = step === 'verify-user'
      if (!canUseAccess) {
        return { status: 'unavailable' }
      }
      return {
        status: 'available',
        accessToken: refreshedCredential.accessToken,
        generation: operationGeneration,
        accessGeneration: refreshedCredential.accessGeneration
      }
    })
  }

  function currentAuthorization(): AuthAuthorization {
    const currentCredential = session.current
    const hasCredential = currentCredential != null
    const isSignedIn = state.phase === 'signedIn'
    const canReadCredential = isSignedIn && hasCredential
    if (!canReadCredential) {
      return { status: 'unavailable' }
    }
    const checkedAt = dependencies.clock.read()
    const isClockUsable = !checkedAt.discontinuous
    const isAccessCurrent = checkedAt.wallMs < currentCredential.accessTokenExpiresAtMs
    const canUseAccess = isClockUsable && isAccessCurrent
    if (canUseAccess) {
      return {
        status: 'available',
        accessToken: currentCredential.accessToken,
        generation,
        accessGeneration: currentCredential.accessGeneration
      }
    }
    return { status: 'unavailable' }
  }

  function authorization(signal?: AbortSignal): Promise<AuthAuthorization> {
    return waitForAuthorization(() => {
      const isSignedIn = state.phase === 'signedIn'
      if (!isSignedIn) {
        return Promise.resolve({ status: 'unavailable' })
      }
      const refreshing = session.currentRefresh(generation)
      const hasRefresh = refreshing != null
      if (hasRefresh) {
        return refreshing
      }
      const current = currentAuthorization()
      const canUseAccess = current.status === 'available'
      const authorization = canUseAccess ? Promise.resolve(current) : refreshAuthorization()

      return authorization
    }, signal)
  }

  function recoverAuthorization(
    rejected: RejectedAuthorization,
    signal?: AbortSignal
  ): Promise<AuthAuthorization> {
    return waitForAuthorization(() => {
      const credential = session.current
      const hasCredential = credential != null
      const isSignedIn = state.phase === 'signedIn'
      const hasSameGeneration = rejected.generation === generation
      const canRecover = hasCredential && isSignedIn && hasSameGeneration
      if (!canRecover) {
        return Promise.resolve({ status: 'unavailable' })
      }
      const hasNewerAccess = credential.accessGeneration > rejected.accessGeneration
      if (hasNewerAccess) {
        const refreshing = session.currentRefresh(generation)
        const hasRefresh = refreshing != null
        const authorization = hasRefresh ? refreshing : Promise.resolve(currentAuthorization())

        return authorization
      }
      const isCurrentAccess = credential.accessGeneration === rejected.accessGeneration
      if (!isCurrentAccess) {
        return Promise.resolve({ status: 'unavailable' })
      }
      if (rejected.finalRejection) {
        // 기존 logout reservation이 진행 writer를 기다리고 같은 session을 한 번 정리한다.
        return logout('REAUTH_REQUIRED').then(() => ({ status: 'unavailable' }))
      }
      return refreshAuthorization()
    }, signal)
  }

  async function retry(): Promise<AuthCommandResult> {
    const isRestorePaused = state.phase === 'restorePaused'
    const isStorageBlocked = state.phase === 'storageBlocked'
    const canEnterRetry = isRestorePaused || isStorageBlocked
    if (!canEnterRetry) {
      return state.failure('AUTH_NOT_ALLOWED')
    }
    const hasWriter = session.hasWriter
    const hasLogoutFlight = logoutFlight != null
    const hasActiveOperation = hasWriter || hasLogoutFlight
    if (hasActiveOperation) {
      return state.failure('AUTH_BUSY')
    }

    const operationGeneration = generation
    const recoveryPurpose = state.recoveryPurpose
    const resumesCredential = recoveryPurpose === 'resume-credential'
    if (resumesCredential) {
      const currentCredential = session.current
      const hasCurrentCredential = currentCredential != null
      if (!hasCurrentCredential) {
        const refreshToken = session.knownRefresh
        const hasRefreshToken = refreshToken != null
        if (!hasRefreshToken) {
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
      const isCurrentAfterRecovery = generation === operationGeneration
      const hasCurrentCredentialAfterRecovery = isCurrentAfterRecovery && session.current != null
      const canVerify = isCurrentAfterRecovery && hasCurrentCredentialAfterRecovery
      if (canVerify) {
        await verifyRestoredUser(operationGeneration)
      }
      return state.success()
    }

    state.restoring()
    const isCurrentBeforeRetry = generation === operationGeneration
    if (!isCurrentBeforeRetry) {
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
        const isCurrentAfterClear = generation === operationGeneration
        const logoutOwnsCleanup = logoutFlight != null
        const cleanup = decideLocalCleanup({
          cleared,
          isCurrent: isCurrentAfterClear,
          logoutOwnsCleanup
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

  async function performLogout(notice: AuthNotice | null): Promise<AuthCommandResult> {
    const value = pending
    generation += 1
    const logoutGeneration = generation
    const hasPendingLogin = value != null
    if (hasPendingLogin) {
      clearPendingReference(value)
    }
    verification.abort()
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

    const serverFailureNotice = serverConfirmed ? null : 'LOGOUT_SERVER_UNCONFIRMED'
    const logoutNotice = notice ?? serverFailureNotice
    state.signedOut(logoutNotice)
    return state.success()
  }

  function logout(notice: AuthNotice | null = null): Promise<AuthCommandResult> {
    const activeLogout = logoutFlight
    const hasLogoutFlight = activeLogout != null
    if (hasLogoutFlight) {
      return activeLogout
    }
    const pendingLogin = pending
    const hasPendingLogin = pendingLogin != null
    const hasPendingBeforeExchange = hasPendingLogin && pendingLogin.isBeforeExchange
    if (hasPendingBeforeExchange) {
      return cancelLogin(pendingLogin.attemptId)
    }
    const isSignedOut = state.phase === 'signedOut'
    const hasWriter = isSignedOut && session.hasWriter
    const isAlreadySignedOut = isSignedOut && !hasWriter
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
      const ownsLogoutFlight = logoutFlight === operation
      if (ownsLogoutFlight) {
        logoutFlight = null
      }
    }
    void operation.then(clearLogout, clearLogout)
    void performLogout(notice).then(resolveLogout, rejectLogout)
    return operation
  }

  function captureGeneration(): number | null {
    const isSignedIn = state.phase === 'signedIn'
    const capturedGeneration = isSignedIn ? generation : null

    return capturedGeneration
  }

  return {
    getSnapshot: state.getSnapshot,
    subscribe: state.subscribe,
    start,
    beginLogin,
    cancelLogin,
    handleReturnUrl,
    retryAuth: retry,
    captureGeneration,
    authorization,
    recoverAuthorization,
    logout
  }
}
