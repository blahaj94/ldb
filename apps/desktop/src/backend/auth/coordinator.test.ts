import { describe, expect, it, vi } from 'vitest'
import { createAuthCoordinator } from './coordinator'
import { AuthHttpFailure } from './http'
import {
  ACCESS_1,
  ACCESS_2,
  ATTEMPT_ID,
  CODE,
  NEXT_ATTEMPT_ID,
  OTHER_CODE,
  REFRESH_0,
  REFRESH_1,
  REFRESH_2,
  REQUEST_ID,
  RETURN_TARGET,
  USER_ID,
  createAuthHarness,
  deferred,
  settle,
  tokenResponse
} from './auth-test-fixtures'

async function waitForPhase(
  coordinator: ReturnType<typeof createAuthCoordinator>,
  phase: ReturnType<typeof coordinator.getSnapshot>['phase']
): Promise<void> {
  await vi.waitFor(() => {
    expect(coordinator.getSnapshot().phase).toBe(phase)
  })
}

async function beginWaitingLogin(
  coordinator: ReturnType<typeof createAuthCoordinator>
): Promise<void> {
  const result = await coordinator.beginLogin('google')
  expect(result).toMatchObject({ ok: true, snapshot: { phase: 'startingLogin' } })
  await waitForPhase(coordinator, 'waitingBrowser')
}

async function restoreSignedIn(
  coordinator: ReturnType<typeof createAuthCoordinator>,
  harness: ReturnType<typeof createAuthHarness>
): Promise<void> {
  harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
  await coordinator.start()
  expect(coordinator.getSnapshot()).toMatchObject({
    phase: 'signedIn',
    user: { nickname: '모험가000001' },
    entry: 'home'
  })
}

describe('Desktop AuthCoordinator login', () => {
  it('empty store를 확인한 뒤 signedOut을 공개하고 snapshot allowlist만 복사한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)

    expect(coordinator.getSnapshot().phase).toBe('restoring')
    await coordinator.start()

    const snapshot = coordinator.getSnapshot()
    expect(snapshot).toEqual({
      runId: expect.any(String),
      revision: 1,
      phase: 'signedOut',
      providers: ['google', 'discord'],
      login: null,
      user: null,
      entry: null,
      notice: null
    })
    expect(Object.keys(snapshot).sort()).toEqual(
      ['entry', 'login', 'notice', 'phase', 'providers', 'revision', 'runId', 'user'].sort()
    )
  })

  it('독립 PKCE로 request를 만들고 검증한 browser URL을 한 번만 연다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()

    await beginWaitingLogin(coordinator)

    expect(harness.http.createLoginRequest).toHaveBeenCalledTimes(1)
    expect(harness.http.createLoginRequest).toHaveBeenCalledWith(
      {
        provider: 'google',
        clientId: 'desktop',
        codeChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        codeChallengeMethod: 'S256'
      },
      expect.any(AbortSignal)
    )
    expect(harness.browser.open).toHaveBeenCalledTimes(1)
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'waitingBrowser',
      login: {
        attemptId: ATTEMPT_ID,
        provider: 'google',
        expiresAt: '2026-09-06T12:10:00.000Z'
      }
    })
  })

  it.each([
    [true, 'welcome'],
    [false, 'home']
  ] as const)(
    'credential commit과 marker 제거 뒤 신규=%s entry=%s로 로그인한다',
    async (isNewUser, entry) => {
      const harness = createAuthHarness()
      const commit = deferred<'confirmed'>()
      const remove = deferred<'confirmed'>()
      harness.store.commitCredential.mockImplementationOnce(() => commit.promise)
      harness.store.removeTransition.mockImplementationOnce(() => remove.promise)
      harness.http.exchange.mockResolvedValueOnce({
        ...tokenResponse(),
        user: { id: USER_ID, nickname: '모험가000001' },
        isNewUser
      })
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      await beginWaitingLogin(coordinator)

      const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
      await settle()
      expect(coordinator.getSnapshot().phase).toBe('exchanging')

      commit.resolve('confirmed')
      await settle()
      expect(coordinator.getSnapshot().phase).toBe('exchanging')

      remove.resolve('confirmed')
      await returning
      expect(coordinator.getSnapshot()).toMatchObject({
        phase: 'signedIn',
        user: { nickname: '모험가000001' },
        entry,
        login: null
      })
    }
  )

  it('transition 확정→HTTP→credential commit→marker 제거 뒤에만 signedIn을 publish한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)
    harness.operations.length = 0
    const unsubscribe = coordinator.subscribe((snapshot) => {
      harness.operations.push(`publish:${snapshot.phase}`)
    })

    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    unsubscribe()

    expect(harness.operations).toEqual([
      'publish:exchanging',
      'store:establish:exchange',
      'http:exchange',
      'store:commit',
      'store:remove',
      'publish:signedIn'
    ])
  })

  it('exchange HTTP 완료 시 fresh pending time이 만료됐으면 credential을 commit하지 않는다', async () => {
    const harness = createAuthHarness()
    const exchange = deferred<Awaited<ReturnType<typeof harness.http.value.exchange>>>()
    harness.http.exchange.mockImplementationOnce(() => exchange.promise)
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)

    const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    await vi.waitFor(() => expect(harness.http.exchange).toHaveBeenCalledTimes(1))
    harness.clock.elapseWithoutTimers(600_000)
    exchange.resolve({
      ...tokenResponse(),
      user: { id: USER_ID, nickname: '모험가000001' },
      isNewUser: true
    })
    await returning

    expect(harness.store.commitCredential).not.toHaveBeenCalled()
    expect(harness.http.logout).toHaveBeenCalledWith(REFRESH_1, expect.any(AbortSignal))
    expect(harness.store.inspection).toEqual({ status: 'empty' })
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_EXPIRED'
    })
  })

  it.each(['expired', 'discontinuous'] as const)(
    'credential commit 대기 중 pending이 %s이면 marker를 finalize하지 않는다',
    async (reason) => {
      const harness = createAuthHarness()
      const commit = deferred<'confirmed'>()
      const logout = deferred<void>()
      harness.store.commitWaits.push(commit.promise)
      harness.http.logout.mockImplementationOnce(async () => {
        harness.operations.push('http:logout')
        await logout.promise
      })
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      await beginWaitingLogin(coordinator)
      harness.operations.length = 0

      const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
      await vi.waitFor(() => expect(harness.store.commitCredential).toHaveBeenCalledTimes(1))
      if (reason === 'expired') {
        harness.clock.elapseWithoutTimers(600_000)
      } else {
        harness.clock.discontinuous = true
      }
      commit.resolve('confirmed')
      await vi.waitFor(() => expect(harness.http.logout).toHaveBeenCalledTimes(1))

      expect(harness.store.removeTransition).not.toHaveBeenCalled()
      expect(harness.store.storedRefreshToken).toBe(REFRESH_1)
      expect(harness.store.transitionMarker).toBe('exchange')
      expect(harness.store.inspection).toEqual({ status: 'recovery-required' })
      expect(coordinator.getSnapshot().phase).not.toBe('signedIn')

      logout.resolve()
      await returning
      expect(harness.store.inspection).toEqual({ status: 'empty' })
      expect(coordinator.getSnapshot()).toMatchObject({
        phase: 'signedOut',
        notice: 'LOGIN_EXPIRED'
      })
    }
  )

  it('marker finalize 대기 중 cancel되면 ready R1을 다시 marker로 막은 뒤 서버 폐기한다', async () => {
    const harness = createAuthHarness()
    const remove = deferred<'confirmed'>()
    const serverLogout = deferred<void>()
    harness.store.removeWaits.push(remove.promise)
    harness.http.logout.mockImplementationOnce(async () => {
      harness.operations.push('http:logout')
      await serverLogout.promise
    })
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)
    harness.operations.length = 0

    const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    await vi.waitFor(() => expect(harness.store.removeTransition).toHaveBeenCalledTimes(1))
    await coordinator.cancelLogin(ATTEMPT_ID)
    remove.resolve('confirmed')
    await vi.waitFor(() => expect(harness.http.logout).toHaveBeenCalledTimes(1))

    const reestablishIndex = harness.operations.indexOf('store:reestablish:exchange')
    const logoutIndex = harness.operations.indexOf('http:logout')
    expect(reestablishIndex).toBeGreaterThan(-1)
    expect(logoutIndex).toBeGreaterThan(reestablishIndex)
    expect(harness.store.storedRefreshToken).toBe(REFRESH_1)
    expect(harness.store.transitionMarker).toBe('exchange')
    expect(harness.store.inspection).toEqual({ status: 'recovery-required' })
    expect(coordinator.getSnapshot().phase).not.toBe('signedIn')

    serverLogout.resolve()
    await returning
    expect(harness.store.inspection).toEqual({ status: 'empty' })
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_CANCELLED'
    })
  })

  it('token, verifier, server identity와 pending 내부값을 snapshot이나 명령 결과에 넣지 않는다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)

    const result = await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    const publicText = JSON.stringify({ result, snapshot: coordinator.getSnapshot() })

    expect(publicText).not.toContain(CODE)
    expect(publicText).not.toContain(REFRESH_1)
    expect(publicText).not.toContain(ACCESS_1)
    expect(publicText).not.toContain(REQUEST_ID)
    expect(publicText).not.toContain(USER_ID)
    expect(publicText).not.toContain(Buffer.alloc(32, 1).toString('base64url'))
  })

  it('취소한 create 응답이 늦게 와도 browser를 열거나 상태를 되살리지 않는다', async () => {
    const harness = createAuthHarness()
    const creation = deferred<Awaited<ReturnType<typeof harness.http.value.createLoginRequest>>>()
    harness.http.createLoginRequest.mockImplementationOnce(() => creation.promise)
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()

    await coordinator.beginLogin('google')
    await coordinator.cancelLogin(ATTEMPT_ID)
    creation.resolve({
      requestId: REQUEST_ID,
      browserUrl: `${harness.dependencies.apiOrigin}/auth/login/authorize?ticket=${Buffer.alloc(32, 8).toString('base64url')}`,
      expiresAt: '2026-09-06T12:10:00.000Z'
    })
    await settle()

    expect(harness.browser.open).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_CANCELLED',
      login: null
    })
  })

  it('exchange 취소 뒤 늦은 token을 publish하지 않고 서버 폐기와 local clear를 끝낸다', async () => {
    const harness = createAuthHarness()
    const exchange = deferred<Awaited<ReturnType<typeof harness.http.value.exchange>>>()
    harness.http.exchange.mockImplementationOnce(() => exchange.promise)
    const coordinator = createAuthCoordinator(harness.dependencies)
    const publishedPhases: string[] = []
    coordinator.subscribe((snapshot) => publishedPhases.push(snapshot.phase))
    await coordinator.start()
    await beginWaitingLogin(coordinator)

    const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    await waitForPhase(coordinator, 'exchanging')
    await vi.waitFor(() => {
      expect(harness.http.exchange).toHaveBeenCalledTimes(1)
    })
    await coordinator.cancelLogin(ATTEMPT_ID)
    await expect(coordinator.beginLogin('google')).resolves.toMatchObject({
      ok: false,
      error: { code: 'AUTH_BUSY' }
    })
    exchange.resolve({
      ...tokenResponse(),
      user: { id: USER_ID, nickname: '모험가000001' },
      isNewUser: true
    })
    await returning

    expect(harness.http.logout).toHaveBeenCalledTimes(1)
    expect(harness.http.logout).toHaveBeenCalledWith(REFRESH_1, expect.any(AbortSignal))
    expect(harness.store.commitCredential).not.toHaveBeenCalled()
    expect(harness.store.clearCredential).toHaveBeenCalledTimes(1)
    expect(publishedPhases).not.toContain('signedIn')
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_CANCELLED'
    })
  })

  it('600초 pending 상한과 clock discontinuity에서 만료하고 늦은 복귀를 교환하지 않는다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)

    harness.clock.advance(600_000)
    await settle()
    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_EXPIRED',
      login: null
    })
    expect(harness.http.exchange).not.toHaveBeenCalled()
  })

  it('clock 불연속 입력은 남은 wall/monotonic 시간과 무관하게 pending을 만료한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)

    harness.clock.discontinuous = true
    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

    expect(harness.http.exchange).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_EXPIRED'
    })
  })

  it('이전 create 결과가 새 attempt 상태와 단조 증가한 revision을 덮지 않는다', async () => {
    const harness = createAuthHarness()
    const firstCreation =
      deferred<Awaited<ReturnType<typeof harness.http.value.createLoginRequest>>>()
    harness.http.createLoginRequest.mockImplementationOnce(() => firstCreation.promise)
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    const revisions: number[] = []
    coordinator.subscribe((snapshot) => revisions.push(snapshot.revision))

    await coordinator.beginLogin('google')
    await vi.waitFor(() => expect(harness.http.createLoginRequest).toHaveBeenCalledTimes(1))
    await coordinator.cancelLogin(ATTEMPT_ID)
    await coordinator.beginLogin('discord')
    await waitForPhase(coordinator, 'waitingBrowser')
    const newAttemptRevision = coordinator.getSnapshot().revision

    firstCreation.resolve({
      requestId: REQUEST_ID,
      browserUrl: `${harness.dependencies.apiOrigin}/auth/login/authorize?ticket=${Buffer.alloc(32, 8).toString('base64url')}`,
      expiresAt: '2026-09-06T12:10:00.000Z'
    })
    await settle()

    expect(coordinator.getSnapshot()).toMatchObject({
      revision: newAttemptRevision,
      phase: 'waitingBrowser',
      login: { attemptId: NEXT_ATTEMPT_ID, provider: 'discord' }
    })
    expect(harness.browser.open).toHaveBeenCalledTimes(1)
    expect(revisions.every((value, index) => index === 0 || value > revisions[index - 1])).toBe(
      true
    )
  })

  it('beginLogin의 이전 recovery clear가 끝나기 전에는 취소 뒤 새 writer를 시작하지 않는다', async () => {
    const harness = createAuthHarness()
    const clear = deferred<'confirmed'>()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    harness.store.inspection = { status: 'recovery-required' }
    harness.store.clearWaits.push(clear.promise)

    await coordinator.beginLogin('google')
    await vi.waitFor(() => expect(harness.store.clearCredential).toHaveBeenCalledTimes(1))
    await coordinator.cancelLogin(ATTEMPT_ID)

    await expect(coordinator.beginLogin('discord')).resolves.toMatchObject({
      ok: false,
      error: { code: 'AUTH_BUSY' }
    })
    expect(harness.http.createLoginRequest).not.toHaveBeenCalled()

    clear.resolve('confirmed')
    await vi.waitFor(() => expect(harness.store.transitionMarker).toBeNull())
    await expect(coordinator.beginLogin('discord')).resolves.toMatchObject({
      ok: true,
      snapshot: { phase: 'startingLogin' }
    })
  })

  it('잘못된 target은 무시하고 같은 callback과 reject fingerprint를 재전송하지 않는다', async () => {
    const harness = createAuthHarness()
    const exchange = deferred<Awaited<ReturnType<typeof harness.http.value.exchange>>>()
    harness.http.exchange.mockImplementationOnce(() => exchange.promise)
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)

    await coordinator.handleReturnUrl(`ldb-test://auth/wrong?code=${CODE}`)
    expect(harness.http.exchange).not.toHaveBeenCalled()

    const first = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    const duplicate = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    const other = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${OTHER_CODE}`)
    await settle()
    expect(harness.http.exchange).toHaveBeenCalledTimes(1)

    exchange.reject(new AuthHttpFailure('exchange-invalid'))
    await Promise.all([first, duplicate, other])
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'waitingBrowser',
      notice: 'LOGIN_RETURN_INVALID'
    })

    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    expect(harness.http.exchange).toHaveBeenCalledTimes(1)
  })

  it('browser 실패는 pending을 폐기하고 정제 notice만 남긴다', async () => {
    const harness = createAuthHarness()
    harness.browser.open.mockRejectedValueOnce(new Error(`browser ${CODE}`))
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await coordinator.beginLogin('google')
    await waitForPhase(coordinator, 'signedOut')

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'BROWSER_OPEN_FAILED',
      login: null
    })
    expect(JSON.stringify(coordinator.getSnapshot())).not.toContain(CODE)
  })

  it.each([
    [new AuthHttpFailure('network'), 'NETWORK_UNAVAILABLE'],
    [new AuthHttpFailure('unavailable'), 'AUTH_SERVICE_UNAVAILABLE'],
    [new AuthHttpFailure('invalid-response'), 'LOGIN_RESTART_REQUIRED']
  ] as const)('login request 실패를 raw 상세 없이 %s → %s로 끝낸다', async (failure, notice) => {
    const harness = createAuthHarness()
    harness.http.createLoginRequest.mockRejectedValueOnce(failure)
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()

    await coordinator.beginLogin('google')
    await waitForPhase(coordinator, 'signedOut')

    expect(harness.browser.open).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', notice, login: null })
  })

  it('transition marker 확정 실패는 exchange HTTP 없이 storageBlocked로 끝낸다', async () => {
    const harness = createAuthHarness()
    harness.store.establishOutcomes.push('failed')
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)

    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

    expect(harness.http.exchange).not.toHaveBeenCalled()
    expect(harness.store.commitCredential).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'storageBlocked',
      notice: 'SECURE_STORAGE_UNAVAILABLE'
    })
  })

  it('credential commit 실패는 known refresh를 한 번 폐기하고 로그인 성공을 공개하지 않는다', async () => {
    const harness = createAuthHarness()
    harness.store.commitOutcomes.push('failed')
    const coordinator = createAuthCoordinator(harness.dependencies)
    const phases: string[] = []
    coordinator.subscribe((snapshot) => phases.push(snapshot.phase))
    await coordinator.start()
    await beginWaitingLogin(coordinator)

    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

    expect(harness.http.logout).toHaveBeenCalledTimes(1)
    expect(harness.http.logout).toHaveBeenCalledWith(REFRESH_1, expect.any(AbortSignal))
    expect(phases).not.toContain('signedIn')
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'storageBlocked',
      notice: 'TOKEN_SAVE_FAILED'
    })
  })

  it('marker 제거 불명 뒤 재확립 성공/실패를 서로 다른 저장 notice로 결정한다', async () => {
    for (const [reestablished, notice] of [
      ['confirmed', 'TOKEN_SAVE_FAILED'],
      ['unknown', 'LOCAL_CLEAR_UNCONFIRMED']
    ] as const) {
      const harness = createAuthHarness()
      harness.store.removeOutcomes.push('unknown')
      harness.store.unknownRemoveApplied.push(true)
      harness.store.reestablishOutcomes.push(reestablished)
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      await beginWaitingLogin(coordinator)

      await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

      expect(coordinator.getSnapshot()).toMatchObject({ phase: 'storageBlocked', notice })
      expect(harness.http.logout).toHaveBeenCalledWith(REFRESH_1, expect.any(AbortSignal))
      expect(harness.store.reestablishTransition).toHaveBeenCalledWith('exchange')
      expect(harness.store.inspection).toEqual(
        reestablished === 'confirmed'
          ? { status: 'recovery-required' }
          : { status: 'ready', refreshToken: REFRESH_1 }
      )
    }
  })

  it('지원 provider, 현재 phase와 attemptId를 command 경계에서 검사한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()

    await expect(coordinator.beginLogin('github')).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_AUTH_COMMAND' }
    })
    await beginWaitingLogin(coordinator)
    await expect(coordinator.beginLogin('discord')).resolves.toMatchObject({
      ok: false,
      error: { code: 'AUTH_BUSY' }
    })
    await expect(coordinator.cancelLogin(NEXT_ATTEMPT_ID)).resolves.toMatchObject({
      ok: false,
      error: { code: 'STALE_ATTEMPT' }
    })
  })
})

describe('Desktop AuthCoordinator restore, refresh와 logout', () => {
  it('ready credential을 refresh commit한 뒤 GET /me 확인 전에는 signedIn을 공개하지 않는다', async () => {
    const harness = createAuthHarness()
    const me = deferred<Awaited<ReturnType<typeof harness.http.value.me>>>()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    harness.http.me.mockImplementationOnce(() => me.promise)
    const coordinator = createAuthCoordinator(harness.dependencies)

    const starting = coordinator.start()
    await vi.waitFor(() => {
      expect(harness.store.commitCredential).toHaveBeenCalledWith(REFRESH_1)
    })
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'restoring', user: null })
    expect(harness.http.me).toHaveBeenCalledWith(ACCESS_1, expect.any(AbortSignal))

    me.resolve({ user: { id: USER_ID, nickname: '모험가000001' } })
    await starting
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedIn',
      entry: 'home',
      user: { nickname: '모험가000001' }
    })
  })

  it('inspect backend unavailable은 clear하지 않고 storageBlocked에서 같은 restore를 retry한다', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'unavailable' }
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'storageBlocked',
      notice: 'SECURE_STORAGE_UNAVAILABLE'
    })
    expect(harness.store.clearCredential).not.toHaveBeenCalled()

    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    await coordinator.retryAuth()
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedIn', entry: 'home' })
  })

  it('logout 중 늦게 끝난 initial inspection은 credential restore를 다시 시작하지 않는다', async () => {
    const harness = createAuthHarness()
    const inspection = deferred<{ status: 'ready'; refreshToken: string }>()
    harness.store.inspect.mockImplementationOnce(() => inspection.promise)
    const coordinator = createAuthCoordinator(harness.dependencies)

    const starting = coordinator.start()
    const logout = coordinator.logout()
    inspection.resolve({ status: 'ready', refreshToken: REFRESH_0 })
    await Promise.all([starting, logout])

    expect(harness.http.refresh).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', user: null })
  })

  it('restore recovery clear와 logout은 같은 writer를 순서대로 사용하고 늦은 restore를 publish하지 않는다', async () => {
    const harness = createAuthHarness()
    const firstClear = deferred<'confirmed'>()
    harness.store.inspection = { status: 'recovery-required' }
    harness.store.clearWaits.push(firstClear.promise)
    const coordinator = createAuthCoordinator(harness.dependencies)

    const starting = coordinator.start()
    await vi.waitFor(() => expect(harness.store.clearCredential).toHaveBeenCalledTimes(1))
    const logout = coordinator.logout()
    expect(coordinator.getSnapshot().phase).toBe('signingOut')

    firstClear.resolve('confirmed')
    await Promise.all([starting, logout])

    expect(harness.store.clearCredential).toHaveBeenCalledTimes(2)
    expect(harness.http.refresh).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', user: null })
  })

  it('corrupt/transition recovery는 credential을 사용하지 않고 clear 확인 뒤 재로그인을 요구한다', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'recovery-required' }
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()

    expect(harness.http.refresh).not.toHaveBeenCalled()
    expect(harness.store.clearCredential).toHaveBeenCalledTimes(1)
    expect(harness.operations).toEqual([
      'store:inspect',
      'store:establish:clear',
      'store:clear',
      'store:remove'
    ])
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'REAUTH_REQUIRED'
    })
  })

  it('refresh 뒤 GET /me 일시 장애는 R1을 보존하고 안전한 retry에서 GET /me만 다시 호출한다', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    harness.http.me
      .mockRejectedValueOnce(new AuthHttpFailure('network'))
      .mockResolvedValueOnce({ user: { id: USER_ID, nickname: '모험가000001' } })
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'restorePaused',
      notice: 'NETWORK_UNAVAILABLE',
      user: null
    })
    await coordinator.retryAuth()

    expect(harness.http.refresh).toHaveBeenCalledTimes(1)
    expect(harness.http.me).toHaveBeenCalledTimes(2)
    expect(harness.http.me).toHaveBeenNthCalledWith(1, ACCESS_1, expect.any(AbortSignal))
    expect(harness.http.me).toHaveBeenNthCalledWith(2, ACCESS_1, expect.any(AbortSignal))
    expect(harness.store.commitCredential).toHaveBeenCalledTimes(1)
    expect(harness.store.commitCredential).toHaveBeenCalledWith(REFRESH_1)
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedIn', entry: 'home' })
  })

  it('refresh가 전송 전 취소된 restore만 R0 marker를 되돌리고 안전하게 다시 보낸다', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    harness.http.refresh.mockRejectedValueOnce(new AuthHttpFailure('network', 'not-sent'))
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'restorePaused',
      notice: 'NETWORK_UNAVAILABLE'
    })
    expect(harness.store.removeTransition).toHaveBeenCalledTimes(1)

    await coordinator.retryAuth()

    expect(harness.http.refresh).toHaveBeenCalledTimes(2)
    expect(harness.http.refresh).toHaveBeenNthCalledWith(1, REFRESH_0, expect.any(AbortSignal))
    expect(harness.http.refresh).toHaveBeenNthCalledWith(2, REFRESH_0, expect.any(AbortSignal))
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedIn', entry: 'home' })
  })

  it('만료 access의 동시 caller가 refresh HTTP와 동일 authorization 결과를 공유한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await restoreSignedIn(coordinator, harness)
    harness.clock.advance(16 * 60_000)
    harness.http.refresh.mockClear()
    harness.store.commitCredential.mockClear()
    const refresh = deferred<ReturnType<typeof tokenResponse>>()
    harness.http.refresh.mockImplementationOnce(() => refresh.promise)

    const first = coordinator.authorization()
    const second = coordinator.authorization()
    await settle()
    expect(harness.http.refresh).toHaveBeenCalledTimes(1)

    refresh.resolve(tokenResponse(REFRESH_2, ACCESS_2, '2026-09-06T12:31:00.000Z'))
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(firstResult).toMatchObject({ status: 'available', accessToken: ACCESS_2 })
    expect(harness.store.commitCredential).toHaveBeenCalledTimes(1)
  })

  it('refresh 중 logout은 R1로 즉시 서버 logout하고 늦은 R2를 commit하거나 복구하지 않는다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await restoreSignedIn(coordinator, harness)
    harness.clock.advance(16 * 60_000)
    harness.store.commitCredential.mockClear()
    const refresh = deferred<ReturnType<typeof tokenResponse>>()
    harness.http.refresh.mockImplementationOnce(() => refresh.promise)

    const authorization = coordinator.authorization()
    await settle()
    const logout = coordinator.logout()
    await vi.waitFor(() => {
      expect(harness.http.logout).toHaveBeenCalledWith(REFRESH_1, expect.any(AbortSignal))
    })
    expect(coordinator.getSnapshot().phase).toBe('signingOut')

    refresh.resolve(tokenResponse(REFRESH_2, ACCESS_2, '2026-09-06T12:31:00.000Z'))
    const [authorizationResult] = await Promise.all([authorization, logout])
    expect(authorizationResult).toEqual({ status: 'unavailable' })
    expect(harness.store.commitCredential).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', user: null })
  })

  it('refresh marker 확립 전 logout은 writer를 무효화한 뒤 clear marker를 먼저 만든다', async () => {
    const harness = createAuthHarness()
    const marker = deferred<'confirmed'>()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await restoreSignedIn(coordinator, harness)
    harness.clock.advance(16 * 60_000)
    harness.http.logout.mockClear()
    harness.store.establishWaits.push(marker.promise)

    const authorization = coordinator.authorization()
    await vi.waitFor(() => expect(harness.store.establishTransition).toHaveBeenCalledTimes(2))
    const logout = coordinator.logout()
    expect(harness.http.logout).not.toHaveBeenCalled()

    marker.resolve('confirmed')
    await vi.waitFor(() => expect(harness.http.logout).toHaveBeenCalledTimes(1))
    const clearMarkerIndex = harness.operations.lastIndexOf('store:establish:clear')
    const logoutIndex = harness.operations.lastIndexOf('http:logout')
    expect(clearMarkerIndex).toBeGreaterThan(-1)
    expect(logoutIndex).toBeGreaterThan(clearMarkerIndex)

    const [authorizationResult] = await Promise.all([authorization, logout])
    expect(authorizationResult).toEqual({ status: 'unavailable' })
    expect(harness.http.refresh).toHaveBeenCalledTimes(1)
  })

  it('refresh 401/결과 불명은 R0를 다시 쓰지 않고 clear 뒤 재로그인을 요구한다', async () => {
    for (const failure of [
      new AuthHttpFailure('authentication-required'),
      new AuthHttpFailure('network', 'unknown')
    ]) {
      const harness = createAuthHarness()
      harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
      harness.http.refresh.mockRejectedValueOnce(failure)
      const coordinator = createAuthCoordinator(harness.dependencies)

      await coordinator.start()

      expect(harness.http.refresh).toHaveBeenCalledTimes(1)
      expect(harness.http.refresh).toHaveBeenCalledWith(REFRESH_0, expect.any(AbortSignal))
      expect(harness.store.clearCredential).toHaveBeenCalledTimes(1)
      expect(coordinator.getSnapshot()).toMatchObject({
        phase: 'signedOut',
        notice: 'REAUTH_REQUIRED'
      })
      await expect(coordinator.retryAuth()).resolves.toMatchObject({
        ok: false,
        error: { code: 'AUTH_NOT_ALLOWED' }
      })
      expect(harness.http.refresh).toHaveBeenCalledTimes(1)
    }
  })

  it('GET /me 최종 401은 generation을 무효화하고 local credential을 clear한다', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    harness.http.me.mockRejectedValueOnce(new AuthHttpFailure('authentication-required'))
    const coordinator = createAuthCoordinator(harness.dependencies)

    await coordinator.start()

    expect(harness.http.logout).toHaveBeenCalledWith(REFRESH_1, expect.any(AbortSignal))
    expect(harness.store.clearCredential).toHaveBeenCalledTimes(1)
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'REAUTH_REQUIRED',
      user: null
    })
    await expect(coordinator.authorization()).resolves.toEqual({ status: 'unavailable' })
  })

  it('GET /me 401 정리와 explicit logout은 서버 폐기 한 번을 공유하고 늦은 clear를 publish하지 않는다', async () => {
    const harness = createAuthHarness()
    const me = deferred<Awaited<ReturnType<typeof harness.http.value.me>>>()
    const serverLogout = deferred<void>()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    harness.http.me.mockImplementationOnce(() => me.promise)
    harness.http.logout.mockImplementationOnce(async () => {
      harness.operations.push('http:logout')
      await serverLogout.promise
    })
    const coordinator = createAuthCoordinator(harness.dependencies)

    const starting = coordinator.start()
    await vi.waitFor(() => expect(harness.http.me).toHaveBeenCalledTimes(1))
    me.reject(new AuthHttpFailure('authentication-required'))
    await vi.waitFor(() => expect(harness.http.logout).toHaveBeenCalledTimes(1))

    const logout = coordinator.logout()
    expect(coordinator.getSnapshot().phase).toBe('signingOut')
    serverLogout.resolve()
    await Promise.all([starting, logout])

    expect(harness.http.logout).toHaveBeenCalledTimes(1)
    expect(harness.store.clearCredential).toHaveBeenCalledTimes(1)
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', notice: null })
  })

  it('동시 logout은 서버 요청과 결과를 공유하고 server/local 결과 우선순위를 지킨다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await restoreSignedIn(coordinator, harness)
    harness.http.logout.mockRejectedValueOnce(new AuthHttpFailure('unavailable'))

    const [first, second] = await Promise.all([coordinator.logout(), coordinator.logout()])

    expect(harness.http.logout).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      ok: true,
      snapshot: { phase: 'signedOut', notice: 'LOGOUT_SERVER_UNCONFIRMED' }
    })

    const blockedHarness = createAuthHarness()
    const blocked = createAuthCoordinator(blockedHarness.dependencies)
    await restoreSignedIn(blocked, blockedHarness)
    blockedHarness.http.logout.mockRejectedValueOnce(new AuthHttpFailure('unavailable'))
    blockedHarness.store.clearOutcomes.push('unknown')

    await blocked.logout()
    expect(blocked.getSnapshot()).toMatchObject({
      phase: 'storageBlocked',
      notice: 'LOCAL_CLEAR_UNCONFIRMED'
    })
  })

  it('idle signedIn logout은 durable clear marker를 HTTP 전에 확립하고 완료 전 ready 복원을 막는다', async () => {
    const harness = createAuthHarness()
    const serverLogout = deferred<void>()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await restoreSignedIn(coordinator, harness)
    coordinator.subscribe((snapshot) => harness.operations.push(`publish:${snapshot.phase}`))
    harness.operations.length = 0
    harness.http.logout.mockImplementationOnce(async () => {
      harness.operations.push('http:logout')
      await serverLogout.promise
    })

    const logout = coordinator.logout()
    await vi.waitFor(() => expect(harness.http.logout).toHaveBeenCalledTimes(1))

    expect(harness.operations).toEqual([
      'publish:signingOut',
      'store:establish:clear',
      'http:logout'
    ])
    expect(harness.store.storedRefreshToken).toBe(REFRESH_1)
    expect(harness.store.transitionMarker).toBe('clear')
    expect(harness.store.inspection).toEqual({ status: 'recovery-required' })

    serverLogout.resolve()
    await logout
    expect(harness.store.inspection).toEqual({ status: 'empty' })
  })

  it('logout marker 확립 실패도 known token 서버 폐기는 한 번 시도하고 local blocked를 우선한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await restoreSignedIn(coordinator, harness)
    harness.store.establishOutcomes.push('failed')
    harness.http.logout.mockClear()

    await coordinator.logout()

    expect(harness.http.logout).toHaveBeenCalledTimes(1)
    expect(harness.http.logout).toHaveBeenCalledWith(REFRESH_1, expect.any(AbortSignal))
    expect(harness.store.clearCredential).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'storageBlocked',
      notice: 'LOCAL_CLEAR_UNCONFIRMED'
    })
  })

  it('logout clear의 marker 제거 불명은 재확립해도 clean 성공으로 표시하지 않는다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await restoreSignedIn(coordinator, harness)
    harness.store.removeOutcomes.push('unknown')
    harness.store.reestablishOutcomes.push('confirmed')

    await coordinator.logout()

    expect(harness.store.reestablishTransition).toHaveBeenCalledWith('clear')
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'storageBlocked',
      notice: 'LOCAL_CLEAR_UNCONFIRMED'
    })
  })

  it('uncertain marker가 남은 credential은 새 coordinator가 refresh하지 않고 clear한다', async () => {
    const harness = createAuthHarness()
    harness.store.removeOutcomes.push('unknown')
    harness.store.unknownRemoveApplied.push(true)
    harness.store.reestablishOutcomes.push('confirmed')
    const first = createAuthCoordinator(harness.dependencies)
    await first.start()
    await beginWaitingLogin(first)
    await first.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

    expect(harness.store.storedRefreshToken).toBe(REFRESH_1)
    expect(harness.store.inspection).toEqual({ status: 'recovery-required' })
    harness.http.refresh.mockClear()

    const restarted = createAuthCoordinator(harness.dependencies)
    await restarted.start()

    expect(harness.http.refresh).not.toHaveBeenCalled()
    expect(harness.store.inspection).toEqual({ status: 'empty' })
    expect(restarted.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'REAUTH_REQUIRED'
    })
  })
})
