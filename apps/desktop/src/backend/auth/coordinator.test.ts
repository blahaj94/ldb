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

  it('분리 호출한 snapshot/subscribe도 복사와 동일 상태의 revision 알림을 보존한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    const { getSnapshot, subscribe } = coordinator
    const listener = vi.fn()
    const unsubscribe = subscribe(listener)
    const revision = getSnapshot().revision
    expect(listener).not.toHaveBeenCalled()

    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls.map(([snapshot]) => snapshot.revision)).toEqual([
      revision + 1,
      revision + 2
    ])
    const copy = getSnapshot()
    Reflect.set(copy, 'phase', 'signedIn')
    Reflect.set(copy.providers, '0', 'discord')
    expect(getSnapshot()).toMatchObject({
      revision: revision + 2,
      phase: 'signedOut',
      providers: ['google', 'discord']
    })
    unsubscribe()
    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(getSnapshot().revision).toBe(revision + 3)
  })

  it('startingLogin listener의 취소 뒤에도 명령은 발행 당시 snapshot을 반환한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    const revision = coordinator.getSnapshot().revision
    const unsubscribe = coordinator.subscribe((snapshot) => {
      const isStarting = snapshot.phase === 'startingLogin'
      if (isStarting) {
        void coordinator.cancelLogin(ATTEMPT_ID)
      }
    })

    const result = await coordinator.beginLogin('google')

    expect(result).toMatchObject({
      ok: true,
      snapshot: { phase: 'startingLogin', revision: revision + 1 }
    })
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_CANCELLED',
      revision: revision + 2
    })
    unsubscribe()
  })

  it.each(['discontinuous', 'expired', 'reversed'] as const)(
    'beginLogin의 동기 expiry 검사에서 %s이면 만료 상태를 보존하고 다시 시작할 수 있다',
    async (reason) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      const startedAt = harness.clock.read()
      const isDiscontinuous = reason === 'discontinuous'
      const isExpired = reason === 'expired'
      const isReversed = reason === 'reversed'
      const checkedAt = {
        wallMs: startedAt.wallMs + (isExpired ? 600_000 : 0),
        monotonicMs: startedAt.monotonicMs + (isExpired ? 600_000 : 0) - (isReversed ? 1 : 0),
        discontinuous: isDiscontinuous
      }
      const readClock = vi.spyOn(harness.clock, 'read')
      readClock.mockReturnValueOnce(startedAt).mockReturnValueOnce(checkedAt)

      const result = await coordinator.beginLogin('google')

      expect(result.snapshot).toMatchObject({
        phase: 'signedOut',
        login: null,
        notice: 'LOGIN_EXPIRED'
      })
      expect(harness.http.createLoginRequest).not.toHaveBeenCalled()
      expect(harness.browser.open).not.toHaveBeenCalled()
      readClock.mockRestore()
      await beginWaitingLogin(coordinator)
    }
  )

  it.each([
    ['wallMs', 'response'],
    ['monotonicMs', 'response'],
    ['wallMs', 'reschedule'],
    ['monotonicMs', 'reschedule'],
    ['wallMs', 'callback'],
    ['monotonicMs', 'callback']
  ] as const)('최근 clock 관측보다 %s가 %s에서 역행하면 만료한다', async (axis, boundary) => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    const startedAt = harness.clock.read()
    const advanced = {
      ...startedAt,
      wallMs: startedAt.wallMs + 200,
      monotonicMs: startedAt.monotonicMs + 200
    }
    const reversed = { ...advanced, [axis]: startedAt[axis] + 150 }
    const readClock = vi.spyOn(harness.clock, 'read')
    readClock.mockReturnValue(advanced).mockReturnValueOnce(startedAt).mockReturnValueOnce(advanced)
    const isResponse = boundary === 'response'
    const isReschedule = boundary === 'reschedule'
    const isCallback = boundary === 'callback'
    if (isResponse) {
      readClock.mockReturnValue(reversed)
    } else if (isReschedule) {
      readClock.mockReturnValueOnce(advanced).mockReturnValue(reversed)
    }

    await coordinator.beginLogin('google')
    await settle()
    if (isCallback) {
      expect(coordinator.getSnapshot().phase).toBe('waitingBrowser')
      // Early timer 재예약도 수용한 관측 history를 유지해야 한다.
      harness.clock.scheduled.at(-1)!.callback()
      readClock.mockReturnValue(reversed)
      await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    }

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      login: null,
      notice: 'LOGIN_EXPIRED'
    })
    expect(harness.http.exchange).not.toHaveBeenCalled()
    expect(harness.browser.open).toHaveBeenCalledTimes(isCallback ? 1 : 0)
  })

  it.each([0, 100])('최근 clock 관측과 같거나 %i ms 전진하면 정상 교환한다', async (advance) => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)
    harness.clock.elapseWithoutTimers(200)
    harness.clock.scheduled.at(-1)!.callback()
    harness.clock.elapseWithoutTimers(advance)

    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

    expect(coordinator.getSnapshot().phase).toBe('signedIn')
    expect(harness.http.exchange).toHaveBeenCalledTimes(1)
  })

  it.each(['monotonic', 'server'] as const)(
    '최근 clock 관측과 timer 재예약은 최초 %s 만료 상한을 연장하지 않는다',
    async (deadline) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      await beginWaitingLogin(coordinator)
      const startedAt = harness.clock.read()
      harness.clock.elapseWithoutTimers(200)
      harness.clock.scheduled.at(-1)!.callback()
      const isMonotonic = deadline === 'monotonic'
      harness.clock.wallMs = startedAt.wallMs + (isMonotonic ? 300 : 600_000)
      harness.clock.monotonicMs = startedAt.monotonicMs + (isMonotonic ? 600_000 : 300)

      await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

      expect(coordinator.getSnapshot()).toMatchObject({
        phase: 'signedOut',
        login: null,
        notice: 'LOGIN_EXPIRED'
      })
      expect(harness.http.exchange).not.toHaveBeenCalled()
    }
  )

  it('최초 clock reading만 불연속이어도 외부 효과 없이 만료되고 새 로그인을 시작할 수 있다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    const normalReading = harness.clock.read()
    const readClock = vi.spyOn(harness.clock, 'read')
    readClock.mockReturnValueOnce({ ...normalReading, discontinuous: true })

    const result = await coordinator.beginLogin('google')
    await settle()

    expect(result.snapshot).toMatchObject({
      phase: 'signedOut',
      login: null,
      notice: 'LOGIN_EXPIRED'
    })
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      login: null,
      notice: 'LOGIN_EXPIRED'
    })
    expect(harness.http.createLoginRequest).not.toHaveBeenCalled()
    expect(harness.browser.open).not.toHaveBeenCalled()
    readClock.mockRestore()
    await beginWaitingLogin(coordinator)
  })

  it.each([
    'discontinuous',
    'wall-reversed',
    'monotonic-reversed',
    'deadline',
    'server-deadline'
  ] as const)(
    'login 응답의 expiry 재설정에서 %s이면 만료를 유지하고 browser를 열지 않는다',
    async (reason) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      const normalReading = harness.clock.read()
      const isDiscontinuous = reason === 'discontinuous'
      const isWallReversed = reason === 'wall-reversed'
      const isMonotonicReversed = reason === 'monotonic-reversed'
      const hasReachedDeadline = reason === 'deadline'
      const hasReachedServerDeadline = reason === 'server-deadline'
      const expiredReading = {
        wallMs:
          normalReading.wallMs +
          (hasReachedServerDeadline ? 600_000 : 0) -
          (isWallReversed ? 1 : 0),
        monotonicMs:
          normalReading.monotonicMs +
          (hasReachedDeadline ? 600_000 : 0) -
          (isMonotonicReversed ? 1 : 0),
        discontinuous: isDiscontinuous
      }
      const readClock = vi.spyOn(harness.clock, 'read')
      readClock
        .mockReturnValueOnce(normalReading)
        .mockReturnValueOnce(normalReading)
        .mockReturnValueOnce(normalReading)
        .mockReturnValueOnce(expiredReading)

      await coordinator.beginLogin('google')
      await settle()

      expect(coordinator.getSnapshot()).toMatchObject({
        phase: 'signedOut',
        login: null,
        notice: 'LOGIN_EXPIRED'
      })
      expect(harness.http.createLoginRequest).toHaveBeenCalledTimes(1)
      expect(harness.browser.open).not.toHaveBeenCalled()
      readClock.mockRestore()
      await beginWaitingLogin(coordinator)
    }
  )

  it.each(['cancel', 'logout'] as const)(
    'waitingBrowser의 동기 listener가 %s하면 browser를 열지 않고 다음 로그인은 정상 시작한다',
    async (action) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      const shouldCancel = action === 'cancel'
      const listener = vi.fn((snapshot: ReturnType<typeof coordinator.getSnapshot>) => {
        const isWaitingBrowser = snapshot.phase === 'waitingBrowser'
        const login = snapshot.login
        const hasLogin = login != null
        const shouldInvalidate = isWaitingBrowser && hasLogin
        if (shouldInvalidate) {
          if (shouldCancel) {
            void coordinator.cancelLogin(login.attemptId)
          } else {
            void coordinator.logout()
          }
        }
      })
      const unsubscribe = coordinator.subscribe(listener)

      await coordinator.beginLogin('google')
      await settle()

      expect(coordinator.getSnapshot()).toMatchObject({
        phase: 'signedOut',
        login: null,
        notice: 'LOGIN_CANCELLED'
      })
      expect(harness.http.createLoginRequest).toHaveBeenCalledTimes(1)
      expect(harness.browser.open).not.toHaveBeenCalled()
      expect(harness.http.logout).not.toHaveBeenCalled()
      unsubscribe()
      await beginWaitingLogin(coordinator)
      expect(harness.http.createLoginRequest).toHaveBeenCalledTimes(2)
      expect(harness.browser.open).toHaveBeenCalledTimes(1)
    }
  )

  it('signedOut의 pending 없는 정상 복귀는 HTTP 없이 새 로그인 안내를 공개한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()

    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      login: null,
      notice: 'LOGIN_RESTART_REQUIRED'
    })
    expect(harness.http.exchange).not.toHaveBeenCalled()
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
      const isExpired = reason === 'expired'
      if (isExpired) {
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

  it.each([
    ['commit', 'cancel', false, 'confirmed'],
    ['commit', 'expiry', true, 'confirmed'],
    ['finalize', 'cancel', false, 'confirmed'],
    ['finalize', 'expiry', true, 'confirmed'],
    ['reestablish', 'cancel', false, 'confirmed'],
    ['reestablish', 'expiry', true, 'confirmed'],
    ['reestablish', 'cancel', false, 'failed'],
    ['reestablish', 'expiry', true, 'failed']
  ] as const)(
    'exchange %s 실패 폐기 중 %s: 서버 성공=%s, local clear=%s도 stale credential을 복원하지 않는다',
    async (failureStage, invalidation, serverConfirmed, clearOutcome) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      await beginWaitingLogin(coordinator)
      const isCommitFailure = failureStage === 'commit'
      const isReestablishFailure = failureStage === 'reestablish'
      if (isCommitFailure) {
        harness.store.commitOutcomes.push('failed')
      } else {
        harness.store.removeOutcomes.push('unknown')
        harness.store.unknownRemoveApplied.push(true)
        if (isReestablishFailure) {
          harness.store.reestablishOutcomes.push('failed')
        }
      }
      harness.store.clearOutcomes.push(clearOutcome)
      const disposal = deferred<void>()
      harness.http.logout.mockImplementationOnce(() => disposal.promise)

      const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
      await vi.waitFor(() => expect(harness.http.logout).toHaveBeenCalledTimes(1))
      const isCancelled = invalidation === 'cancel'
      if (isCancelled) {
        await coordinator.cancelLogin(ATTEMPT_ID)
      } else {
        harness.clock.advance(600_000)
      }
      if (serverConfirmed) {
        disposal.resolve()
      } else {
        disposal.reject(new AuthHttpFailure('unavailable'))
      }
      await returning

      const isLocalClean = clearOutcome === 'confirmed'
      const expectedNotice = isCancelled ? 'LOGIN_CANCELLED' : 'LOGIN_EXPIRED'
      expect(coordinator.getSnapshot()).toMatchObject({
        phase: isLocalClean ? 'signedOut' : 'storageBlocked',
        notice: isLocalClean ? expectedNotice : 'LOCAL_CLEAR_UNCONFIRMED'
      })
      expect(harness.store.clearCredential).toHaveBeenCalledTimes(1)
      expect(harness.store.inspection).toEqual({
        status: isLocalClean ? 'empty' : 'recovery-required'
      })
      expect(harness.http.logout).toHaveBeenCalledTimes(1)

      const restarted = createAuthCoordinator(harness.dependencies)
      await restarted.start()
      expect(harness.http.refresh).not.toHaveBeenCalled()
      expect(restarted.getSnapshot().phase).toBe('signedOut')
      expect(harness.store.inspection).toEqual({ status: 'empty' })
    }
  )

  it.each([
    ['commit', true, 'confirmed'],
    ['commit', false, 'confirmed'],
    ['finalize', true, 'confirmed'],
    ['finalize', false, 'confirmed'],
    ['reestablish', true, 'confirmed'],
    ['reestablish', false, 'confirmed'],
    ['reestablish', false, 'failed'],
    ['reestablish', false, 'unknown']
  ] as const)(
    'exchange 저장 %s 실패 중 logout은 서버 폐기 성공=%s와 local clear=%s를 구분한다',
    async (failureStage, serverConfirmed, clearOutcome) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      await beginWaitingLogin(coordinator)
      const isCommitFailure = failureStage === 'commit'
      const isReestablishFailure = failureStage === 'reestablish'
      if (isCommitFailure) {
        harness.store.commitOutcomes.push('failed')
      } else {
        harness.store.removeOutcomes.push('unknown')
        harness.store.unknownRemoveApplied.push(true)
        if (isReestablishFailure) {
          harness.store.reestablishOutcomes.push('failed')
        }
      }
      harness.store.clearOutcomes.push(clearOutcome)
      const disposal = deferred<void>()
      harness.http.logout.mockImplementationOnce(() => disposal.promise)

      const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
      await vi.waitFor(() => expect(harness.http.logout).toHaveBeenCalledTimes(1))
      const logout = coordinator.logout()
      expect(coordinator.logout()).toBe(logout)
      expect(coordinator.getSnapshot().phase).toBe('signingOut')
      if (serverConfirmed) {
        disposal.resolve()
      } else {
        disposal.reject(new AuthHttpFailure('unavailable'))
      }
      const [, result] = await Promise.all([returning, logout])

      const isLocalClean = clearOutcome === 'confirmed'
      const serverNotice = serverConfirmed ? null : 'LOGOUT_SERVER_UNCONFIRMED'
      expect(result.snapshot).toMatchObject({
        phase: isLocalClean ? 'signedOut' : 'storageBlocked',
        notice: isLocalClean ? serverNotice : 'LOCAL_CLEAR_UNCONFIRMED'
      })
      expect(harness.http.logout).toHaveBeenCalledTimes(1)
      expect(harness.store.inspection.status).toBe(isLocalClean ? 'empty' : 'recovery-required')

      if (!isLocalClean) {
        await coordinator.retryAuth()
      }
      await beginWaitingLogin(coordinator)
      harness.http.exchange.mockResolvedValueOnce({
        ...tokenResponse({ refreshToken: REFRESH_2 }),
        user: { id: USER_ID, nickname: '모험가000001' },
        isNewUser: false
      })
      await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${OTHER_CODE}`)
      await coordinator.logout()
      expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', notice: null })
      expect(harness.http.logout).toHaveBeenCalledTimes(2)
      expect(harness.http.logout).toHaveBeenLastCalledWith(REFRESH_2, expect.any(AbortSignal))
    }
  )

  it('폐기 실패가 settle됐어도 writer가 처리하기 전 시작한 logout에 결과를 전달한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)
    harness.store.commitOutcomes.push('failed')
    const disposal = deferred<void>()
    harness.http.logout.mockImplementationOnce(() => disposal.promise)

    const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    await vi.waitFor(() => expect(harness.http.logout).toHaveBeenCalledTimes(1))
    disposal.reject(new AuthHttpFailure('unavailable'))
    await Promise.resolve()
    const logout = coordinator.logout()
    await Promise.all([returning, logout])

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGOUT_SERVER_UNCONFIRMED'
    })
    expect(harness.store.inspection).toEqual({ status: 'empty' })
    expect(harness.http.logout).toHaveBeenCalledTimes(1)
  })

  it('logout 중 stale finalize의 marker 재확립 실패도 서버 폐기 실패를 전달한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)
    const remove = deferred<'unknown'>()
    harness.store.removeWaits.push(remove.promise)
    harness.store.unknownRemoveApplied.push(true)
    harness.store.reestablishOutcomes.push('failed')
    harness.http.logout.mockRejectedValueOnce(new AuthHttpFailure('unavailable'))

    const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    await vi.waitFor(() => expect(harness.store.removeTransition).toHaveBeenCalledTimes(1))
    const logout = coordinator.logout()
    remove.resolve('unknown')
    await Promise.all([returning, logout])

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGOUT_SERVER_UNCONFIRMED'
    })
    expect(harness.store.inspection).toEqual({ status: 'empty' })
    expect(harness.http.logout).toHaveBeenCalledTimes(1)
  })

  it.each(['confirmed', 'failed'] as const)(
    '취소된 exchange의 서버 폐기 실패와 local clear=%s가 다음 session logout 결과로 새지 않는다',
    async (clearOutcome) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      await beginWaitingLogin(coordinator)
      const exchange = deferred<Awaited<ReturnType<typeof harness.http.value.exchange>>>()
      harness.http.exchange.mockImplementationOnce(() => exchange.promise)
      harness.http.logout.mockRejectedValueOnce(new AuthHttpFailure('unavailable'))
      harness.store.clearOutcomes.push(clearOutcome)

      const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
      await vi.waitFor(() => expect(harness.http.exchange).toHaveBeenCalledTimes(1))
      await coordinator.cancelLogin(ATTEMPT_ID)
      exchange.resolve({
        ...tokenResponse(),
        user: { id: USER_ID, nickname: '모험가000001' },
        isNewUser: true
      })
      await returning
      await settle()
      const isLocalClean = clearOutcome === 'confirmed'
      expect(harness.store.inspection.status).toBe(isLocalClean ? 'empty' : 'recovery-required')
      if (!isLocalClean) {
        await coordinator.retryAuth()
      }
      expect(harness.http.logout).toHaveBeenCalledTimes(1)

      await beginWaitingLogin(coordinator)
      await coordinator.logout()
      expect(coordinator.getSnapshot()).toMatchObject({
        phase: 'signedOut',
        notice: 'LOGIN_CANCELLED'
      })
      await beginWaitingLogin(coordinator)
      await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${OTHER_CODE}`)
      await coordinator.logout()

      expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', notice: null })
      expect(harness.http.logout).toHaveBeenCalledTimes(2)
    }
  )

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

  it.each(['cancel', 'logout'] as const)(
    'exchanging 동기 listener의 %s 뒤에는 exchange writer를 시작하지 않는다',
    async (action) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      await beginWaitingLogin(coordinator)
      const isLogout = action === 'logout'
      const clearMarker = deferred<'confirmed'>()
      if (isLogout) {
        harness.store.establishWaits.push(clearMarker.promise)
      }
      const invalidations: ReturnType<typeof coordinator.logout>[] = []
      const unsubscribe = coordinator.subscribe((snapshot) => {
        const isExchanging = snapshot.phase === 'exchanging'
        if (isExchanging) {
          invalidations.push(isLogout ? coordinator.logout() : coordinator.cancelLogin(ATTEMPT_ID))
        }
      })

      const exchange = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
      await settle()

      expect(invalidations).toHaveLength(1)
      expect(harness.http.exchange).not.toHaveBeenCalled()
      expect(harness.store.establishTransition.mock.calls).toEqual(isLogout ? [['clear']] : [])
      expect(harness.store.commitCredential).not.toHaveBeenCalled()
      expect(harness.store.clearCredential).not.toHaveBeenCalled()
      expect(coordinator.getSnapshot()).toMatchObject({
        phase: isLogout ? 'signingOut' : 'signedOut',
        login: null,
        notice: isLogout ? null : 'LOGIN_CANCELLED'
      })

      clearMarker.resolve('confirmed')
      await Promise.all([exchange, ...invalidations])
      expect(harness.store.clearCredential).toHaveBeenCalledTimes(isLogout ? 1 : 0)
      expect(harness.http.exchange).not.toHaveBeenCalled()
      expect(harness.store.inspection).toEqual({ status: 'empty' })
      unsubscribe()
      await beginWaitingLogin(coordinator)
    }
  )

  it('exchanging listener의 cancel 직후 같은 stack에서 새 login을 시작할 수 있다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)
    const commands: ReturnType<typeof coordinator.beginLogin>[] = []
    const unsubscribe = coordinator.subscribe((snapshot) => {
      const isExchanging = snapshot.phase === 'exchanging'
      if (isExchanging) {
        unsubscribe()
        commands.push(coordinator.cancelLogin(ATTEMPT_ID))
        commands.push(coordinator.beginLogin('discord'))
      }
    })

    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    const [, restarted] = await Promise.all(commands)

    expect(restarted).toMatchObject({ ok: true, snapshot: { phase: 'startingLogin' } })
    await waitForPhase(coordinator, 'waitingBrowser')
    expect(coordinator.getSnapshot().login).toMatchObject({
      attemptId: NEXT_ATTEMPT_ID,
      provider: 'discord'
    })
    expect(harness.http.exchange).not.toHaveBeenCalled()
    expect(harness.store.establishTransition).not.toHaveBeenCalled()
    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${OTHER_CODE}`)
    expect(coordinator.getSnapshot().phase).toBe('signedIn')
    expect(harness.http.exchange).toHaveBeenCalledTimes(1)
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

  it.each([
    ['before-error', 'network', 'unknown', 'confirmed'],
    ['before-error', 'unavailable', 'unknown', 'confirmed'],
    ['before-error', 'invalid-response', 'unknown', 'confirmed'],
    ['during-cleanup', 'network', 'unknown', 'confirmed'],
    ['during-cleanup', 'unavailable', 'unknown', 'confirmed'],
    ['during-cleanup', 'invalid-response', 'unknown', 'confirmed'],
    ['before-error', 'network', 'unknown', 'unknown'],
    ['during-cleanup', 'invalid-response', 'unknown', 'unknown'],
    ['before-error', 'exchange-invalid', 'unknown', 'confirmed'],
    ['during-cleanup', 'exchange-invalid', 'unknown', 'confirmed'],
    ['before-error', 'network', 'not-sent', 'confirmed'],
    ['during-cleanup', 'network', 'not-sent', 'confirmed']
  ] as const)(
    'tokenless exchange의 logout=%s, 오류=%s, 전송=%s, clear=%s 결과를 구분한다',
    async (logoutTiming, errorCode, transmission, clearOutcome) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      await beginWaitingLogin(coordinator)
      const exchange = deferred<Awaited<ReturnType<typeof harness.http.value.exchange>>>()
      harness.http.exchange.mockImplementationOnce(() => exchange.promise)
      const cleanup = deferred<'confirmed'>()
      const isDuringCleanup = logoutTiming === 'during-cleanup'
      if (isDuringCleanup) {
        harness.store.clearWaits.push(cleanup.promise)
      }
      harness.store.clearOutcomes.push(clearOutcome)
      const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
      await vi.waitFor(() => expect(harness.http.exchange).toHaveBeenCalledTimes(1))
      const failure = new AuthHttpFailure(errorCode, transmission)
      let loggingOut: ReturnType<typeof coordinator.logout>

      if (isDuringCleanup) {
        exchange.reject(failure)
        await vi.waitFor(() => expect(harness.store.clearCredential).toHaveBeenCalledTimes(1))
        loggingOut = coordinator.logout()
        cleanup.resolve('confirmed')
      } else {
        loggingOut = coordinator.logout()
        exchange.reject(failure)
      }
      const joined = coordinator.logout()
      expect(joined).toBe(loggingOut)
      expect(harness.http.exchange.mock.calls[0][1].aborted).toBe(true)
      const [result] = await Promise.all([loggingOut, joined, returning])

      const isExplicitRejection = errorCode === 'exchange-invalid'
      const isNetwork = errorCode === 'network'
      const isNotSent = transmission === 'not-sent'
      const isKnownNotSent = isNetwork && isNotSent
      const isServerUnconfirmed = !isExplicitRejection && !isKnownNotSent
      const isLocalClean = clearOutcome === 'confirmed'
      const serverNotice = isServerUnconfirmed ? 'LOGOUT_SERVER_UNCONFIRMED' : null
      expect(result).toMatchObject({
        ok: true,
        snapshot: {
          phase: isLocalClean ? 'signedOut' : 'storageBlocked',
          notice: isLocalClean ? serverNotice : 'LOCAL_CLEAR_UNCONFIRMED',
          login: null,
          user: null
        }
      })
      expect(harness.http.logout).not.toHaveBeenCalled()
      expect(harness.store.commitCredential).not.toHaveBeenCalled()
      expect(harness.store.clearCredential).toHaveBeenCalledTimes(isDuringCleanup ? 2 : 1)
      expect(harness.http.exchange).toHaveBeenCalledTimes(1)

      if (!isLocalClean) {
        await coordinator.retryAuth()
      }
      await beginWaitingLogin(coordinator)
      await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${OTHER_CODE}`)
      expect(coordinator.getSnapshot().phase).toBe('signedIn')
      const nextLogout = await coordinator.logout()
      expect(nextLogout.snapshot).toMatchObject({ phase: 'signedOut', notice: null })
      expect(harness.http.logout).toHaveBeenCalledTimes(1)
    }
  )

  it('tokenless exchange writer가 logout 없이 끝난 결과는 다음 session으로 새지 않는다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)
    harness.http.exchange.mockRejectedValueOnce(new AuthHttpFailure('network', 'unknown'))

    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_RESTART_REQUIRED'
    })
    expect(harness.http.logout).not.toHaveBeenCalled()
    await beginWaitingLogin(coordinator)
    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${OTHER_CODE}`)
    const logout = await coordinator.logout()
    expect(logout.snapshot).toMatchObject({ phase: 'signedOut', notice: null })
    expect(harness.http.logout).toHaveBeenCalledTimes(1)
  })

  it('stale token cleanup 대기 중 시작한 logout이 local 실패의 공개 상태를 소유한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)
    const exchange = deferred<Awaited<ReturnType<typeof harness.http.value.exchange>>>()
    harness.http.exchange.mockImplementationOnce(() => exchange.promise)
    const staleClear = deferred<'failed'>()
    const logoutClear = deferred<'confirmed'>()
    harness.store.clearWaits.push(staleClear.promise, logoutClear.promise)
    const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    await vi.waitFor(() => expect(harness.http.exchange).toHaveBeenCalledTimes(1))
    await coordinator.cancelLogin(ATTEMPT_ID)
    exchange.resolve({
      ...tokenResponse(),
      user: { id: USER_ID, nickname: '모험가000001' },
      isNewUser: true
    })
    await vi.waitFor(() => expect(harness.store.clearCredential).toHaveBeenCalledTimes(1))

    const loggingOut = coordinator.logout()
    staleClear.resolve('failed')
    await vi.waitFor(() => expect(harness.store.clearCredential).toHaveBeenCalledTimes(2))

    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signingOut', notice: null })
    expect(coordinator.logout()).toBe(loggingOut)
    logoutClear.resolve('confirmed')
    await Promise.all([returning, loggingOut])
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', notice: null })
    expect(harness.http.logout).toHaveBeenCalledTimes(1)
    expect(harness.store.inspection).toEqual({ status: 'empty' })
  })

  it('600초 pending 상한과 clock discontinuity에서 만료하고 늦은 복귀를 교환하지 않는다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)

    harness.clock.advance(600_000)
    await settle()
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_EXPIRED',
      login: null
    })

    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_RESTART_REQUIRED',
      login: null
    })
    expect(harness.http.exchange).not.toHaveBeenCalled()
  })

  it('취소된 attempt의 queued timer callback은 새 pending을 만료하거나 다시 예약하지 않는다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)
    const staleCallback = harness.clock.scheduled[0].callback
    await coordinator.cancelLogin(ATTEMPT_ID)
    await beginWaitingLogin(coordinator)
    const current = coordinator.getSnapshot()
    const scheduledCount = harness.clock.scheduled.length

    harness.clock.discontinuous = true
    staleCallback()
    harness.clock.discontinuous = false

    expect(coordinator.getSnapshot()).toEqual(current)
    expect(harness.clock.scheduled).toHaveLength(scheduledCount)
    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${OTHER_CODE}`)
    expect(coordinator.getSnapshot().phase).toBe('signedIn')
    expect(harness.http.exchange).toHaveBeenCalledTimes(1)
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
    const revisionsIncrease = revisions.every((value, index) => {
      const isFirstRevision = index === 0
      if (isFirstRevision) {
        return true
      }

      const isGreaterThanPrevious = value > revisions[index - 1]
      return isGreaterThanPrevious
    })
    expect(revisionsIncrease).toBe(true)
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

  it.each([
    ['cancel', 'failed'],
    ['expiry', 'unknown']
  ] as const)(
    'login 준비 cleanup 중 %s 뒤 clear=%s는 storage recovery 상태를 공개한다',
    async (invalidation, clearOutcome) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      harness.store.inspection = { status: 'recovery-required' }
      const clear = deferred<'failed' | 'unknown'>()
      harness.store.clearWaits.push(clear.promise)
      await coordinator.beginLogin('google')
      await vi.waitFor(() => expect(harness.store.clearCredential).toHaveBeenCalledTimes(1))

      const isCancelled = invalidation === 'cancel'
      if (isCancelled) {
        await coordinator.cancelLogin(ATTEMPT_ID)
      } else {
        harness.clock.advance(600_000)
      }
      clear.resolve(clearOutcome)

      await vi.waitFor(() => {
        expect(coordinator.getSnapshot()).toMatchObject({
          phase: 'storageBlocked',
          notice: 'LOCAL_CLEAR_UNCONFIRMED',
          login: null
        })
      })
      expect(harness.store.inspection).toEqual({ status: 'recovery-required' })
      expect(harness.http.createLoginRequest).not.toHaveBeenCalled()
      expect(harness.browser.open).not.toHaveBeenCalled()
      await coordinator.retryAuth()
      expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut' })
    }
  )

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

  it.each(['success', 'cancel-recover'] as const)(
    '거절 clear 완료의 동기 listener에서 다른 callback으로 writer를 인계한다: %s',
    async (outcome) => {
      const harness = createAuthHarness()
      const effects: string[] = []
      function observeEffect<Args extends unknown[], Result>(
        name: string,
        operation: (...args: Args) => Promise<Result>
      ): (...args: Args) => Promise<Result> {
        let calls = 0
        return (...args) => {
          const label = `${name}:${++calls}`
          effects.push(`${label}:start`)
          const promise = operation(...args)
          void promise.then(
            () => effects.push(`${label}:complete`),
            () => effects.push(`${label}:reject`)
          )
          // 관측 callback만 붙이고 제품이 기다리는 원래 Promise는 그대로 반환한다.
          return promise
        }
      }
      const coordinator = createAuthCoordinator({
        ...harness.dependencies,
        store: {
          inspect: harness.store.inspect,
          establishTransition: observeEffect('marker', harness.store.establishTransition),
          commitCredential: observeEffect('commit', harness.store.commitCredential),
          clearCredential: observeEffect('clear', harness.store.clearCredential),
          removeTransition: observeEffect('remove', harness.store.removeTransition),
          reestablishTransition: harness.store.reestablishTransition
        },
        http: {
          ...harness.http.value,
          exchange: observeEffect('exchange', harness.http.exchange),
          logout: observeEffect('logout', harness.http.logout)
        }
      })
      await coordinator.start()
      await beginWaitingLogin(coordinator)
      const rejectedClear = deferred<'confirmed'>()
      const nextExchange = deferred<Awaited<ReturnType<typeof harness.http.value.exchange>>>()
      harness.store.clearWaits.push(rejectedClear.promise)
      harness.http.exchange
        .mockRejectedValueOnce(new AuthHttpFailure('exchange-invalid'))
        .mockImplementationOnce(() => nextExchange.promise)
      let firstSettled = false
      let nextReturning: Promise<void> | undefined
      const publishedPhases: string[] = []
      const handoff = vi.fn((snapshot: ReturnType<typeof coordinator.getSnapshot>) => {
        expect(firstSettled).toBe(false)
        expect(harness.store.inspection).toEqual({ status: 'empty' })
        effects.push('listener:enter')
        nextReturning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${OTHER_CODE}`)
        expect(coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${OTHER_CODE}`)).toBe(
          nextReturning
        )
        expect(coordinator.getSnapshot()).toMatchObject({ phase: 'exchanging', notice: null })
        expect(snapshot).toMatchObject({
          phase: 'waitingBrowser',
          notice: 'LOGIN_RETURN_INVALID',
          login: { attemptId: ATTEMPT_ID }
        })
        expect(coordinator.getSnapshot().revision).toBe(snapshot.revision + 1)
        effects.push('listener:exit')
      })
      const unsubscribe = coordinator.subscribe((snapshot) => {
        publishedPhases.push(snapshot.phase)
        const isSignedIn = snapshot.phase === 'signedIn'
        if (isSignedIn) {
          effects.push('publish:signedIn')
        }
        const isWaiting = snapshot.phase === 'waitingBrowser'
        const isRejected = snapshot.notice === 'LOGIN_RETURN_INVALID'
        const shouldHandoff = isWaiting && isRejected
        if (shouldHandoff) {
          handoff(snapshot)
        }
      })

      const first = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
      expect(coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)).toBe(first)
      void first.then(() => {
        firstSettled = true
        effects.push('first:settled')
      })
      await vi.waitFor(() => expect(harness.store.clearCredential).toHaveBeenCalledTimes(1))
      expect(handoff).not.toHaveBeenCalled()
      expect(firstSettled).toBe(false)
      expect(effects).toEqual([
        'marker:1:start',
        'marker:1:complete',
        'exchange:1:start',
        'exchange:1:reject',
        'marker:2:start',
        'marker:2:complete',
        'clear:1:start'
      ])
      rejectedClear.resolve('confirmed')
      await first
      await vi.waitFor(() => expect(harness.http.exchange).toHaveBeenCalledTimes(2))

      expect(handoff).toHaveBeenCalledTimes(1)
      expect(firstSettled).toBe(true)
      expect(effects.slice(7, 13)).toEqual([
        'clear:1:complete',
        'remove:1:start',
        'remove:1:complete',
        'listener:enter',
        'marker:3:start',
        'listener:exit'
      ])
      expect(effects).toContain('marker:3:complete')
      expect(effects).toContain('exchange:2:start')
      expect(effects.indexOf('marker:3:complete')).toBeLessThan(effects.indexOf('exchange:2:start'))
      expect(effects).not.toContain('exchange:2:complete')
      expect(harness.store.establishTransition.mock.calls.map(([kind]) => kind)).toEqual([
        'exchange',
        'clear',
        'exchange'
      ])
      expect(harness.http.exchange.mock.calls.map(([input]) => input.code)).toEqual([
        CODE,
        OTHER_CODE
      ])
      expect(harness.store.commitCredential).not.toHaveBeenCalled()
      effects.length = 0

      const isCancelled = outcome === 'cancel-recover'
      const disposal = deferred<void>()
      const lateClear = deferred<'confirmed'>()
      const commit = deferred<'confirmed'>()
      if (isCancelled) {
        await coordinator.cancelLogin(ATTEMPT_ID)
        // 첫 completion이 새 writer를 해제했다면 signedOut의 새 login이 잘못 허용된다.
        await expect(coordinator.beginLogin('discord')).resolves.toMatchObject({
          ok: false,
          error: { code: 'AUTH_BUSY' }
        })
        harness.http.logout.mockImplementationOnce(() => disposal.promise)
        harness.store.clearWaits.push(lateClear.promise)
      } else {
        harness.store.commitWaits.push(commit.promise)
      }
      nextExchange.resolve({
        ...tokenResponse(),
        user: { id: USER_ID, nickname: '모험가000001' },
        isNewUser: true
      })
      if (isCancelled) {
        await vi.waitFor(() => expect(harness.http.logout).toHaveBeenCalledTimes(1))
        expect(effects).toEqual(['exchange:2:complete', 'logout:1:start'])
        expect(harness.store.clearCredential).toHaveBeenCalledTimes(1)
        disposal.resolve()
        await vi.waitFor(() => expect(harness.store.clearCredential).toHaveBeenCalledTimes(2))
        await expect(coordinator.beginLogin('discord')).resolves.toMatchObject({
          ok: false,
          error: { code: 'AUTH_BUSY' }
        })
        expect(publishedPhases).not.toContain('signedIn')
        expect(harness.store.commitCredential).not.toHaveBeenCalled()
        lateClear.resolve('confirmed')
      } else {
        await vi.waitFor(() => expect(harness.store.commitCredential).toHaveBeenCalledTimes(1))
        expect(effects).toEqual(['exchange:2:complete', 'commit:1:start'])
        expect(publishedPhases).not.toContain('signedIn')
        expect(harness.store.removeTransition).toHaveBeenCalledTimes(1)
        commit.resolve('confirmed')
      }
      expect(nextReturning).toBeDefined()
      await nextReturning
      unsubscribe()

      if (isCancelled) {
        expect(effects).toEqual([
          'exchange:2:complete',
          'logout:1:start',
          'logout:1:complete',
          'marker:4:start',
          'marker:4:complete',
          'clear:2:start',
          'clear:2:complete',
          'remove:2:start',
          'remove:2:complete'
        ])
        expect(harness.http.logout).toHaveBeenCalledWith(REFRESH_1, expect.any(AbortSignal))
        expect(harness.store.commitCredential).not.toHaveBeenCalled()
        expect(publishedPhases).not.toContain('signedIn')
        expect(harness.store.inspection).toEqual({ status: 'empty' })
        expect(coordinator.getSnapshot()).toMatchObject({
          phase: 'signedOut',
          notice: 'LOGIN_CANCELLED'
        })
        await expect(coordinator.beginLogin('discord')).resolves.toMatchObject({
          ok: true,
          snapshot: { phase: 'startingLogin', login: { attemptId: NEXT_ATTEMPT_ID } }
        })
        await waitForPhase(coordinator, 'waitingBrowser')
        await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
        expect(coordinator.getSnapshot().phase).toBe('signedIn')
      } else {
        expect(effects).toEqual([
          'exchange:2:complete',
          'commit:1:start',
          'commit:1:complete',
          'remove:2:start',
          'remove:2:complete',
          'publish:signedIn'
        ])
        expect(harness.store.commitCredential).toHaveBeenCalledExactlyOnceWith(REFRESH_1)
        expect(harness.http.logout).not.toHaveBeenCalled()
        expect(
          publishedPhases.filter((phase) => {
            const isSignedIn = phase === 'signedIn'
            return isSignedIn
          })
        ).toHaveLength(1)
        expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedIn', entry: 'welcome' })
      }
      expect(harness.store.inspection).toEqual({ status: 'ready', refreshToken: REFRESH_1 })
    }
  )

  it.each([
    ['cancel', 'confirmed', 'confirmed', 'exchange-invalid'],
    ['expiry', 'confirmed', 'confirmed', 'exchange-invalid'],
    ['cancel', 'failed', 'confirmed', 'exchange-invalid'],
    ['expiry', 'failed', 'confirmed', 'exchange-invalid'],
    ['cancel', 'unknown', 'confirmed', 'exchange-invalid'],
    ['expiry', 'unknown', 'confirmed', 'exchange-invalid'],
    ['cancel', 'confirmed', 'failed', 'exchange-invalid'],
    ['expiry', 'confirmed', 'failed', 'exchange-invalid'],
    ['cancel', 'confirmed', 'unknown', 'exchange-invalid'],
    ['expiry', 'confirmed', 'unknown', 'exchange-invalid'],
    ['cancel', 'failed', 'confirmed', 'network'],
    ['expiry', 'unknown', 'confirmed', 'unavailable'],
    ['cancel', 'confirmed', 'failed', 'invalid-response'],
    ['expiry', 'confirmed', 'unknown', 'network'],
    ['cancel', 'confirmed', 'confirmed', 'network'],
    ['expiry', 'confirmed', 'confirmed', 'invalid-response']
  ] as const)(
    'exchange cleanup 중 %s: clear=%s, marker 재확립=%s, 오류=%s 결과를 공개한다',
    async (invalidation, clearOutcome, markerOutcome, errorCode) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      await beginWaitingLogin(coordinator)
      harness.http.exchange.mockRejectedValueOnce(new AuthHttpFailure(errorCode))
      const clear = deferred<'confirmed' | 'failed' | 'unknown'>()
      harness.store.clearWaits.push(clear.promise)
      const isMarkerUnconfirmed = markerOutcome !== 'confirmed'
      if (isMarkerUnconfirmed) {
        harness.store.removeOutcomes.push('unknown')
        harness.store.unknownRemoveApplied.push(true)
        harness.store.reestablishOutcomes.push(markerOutcome)
      }

      const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
      await vi.waitFor(() => expect(harness.store.clearCredential).toHaveBeenCalledTimes(1))
      const isCancelled = invalidation === 'cancel'
      if (isCancelled) {
        await coordinator.cancelLogin(ATTEMPT_ID)
      } else {
        harness.clock.advance(600_000)
      }
      const invalidationNotice = isCancelled ? 'LOGIN_CANCELLED' : 'LOGIN_EXPIRED'
      expect(coordinator.getSnapshot()).toMatchObject({
        phase: 'signedOut',
        notice: invalidationNotice
      })
      await expect(coordinator.beginLogin('discord')).resolves.toMatchObject({
        ok: false,
        error: { code: 'AUTH_BUSY' }
      })

      clear.resolve(clearOutcome)
      await returning
      await settle()

      const isClearConfirmed = clearOutcome === 'confirmed'
      const isLocalClean = isClearConfirmed && !isMarkerUnconfirmed
      expect(coordinator.getSnapshot()).toMatchObject({
        phase: isLocalClean ? 'signedOut' : 'storageBlocked',
        notice: isLocalClean ? invalidationNotice : 'LOCAL_CLEAR_UNCONFIRMED',
        login: null,
        user: null,
        entry: null
      })
      expect(harness.store.transitionMarker).toBe(isClearConfirmed ? null : 'clear')
      if (isMarkerUnconfirmed) {
        expect(harness.store.reestablishTransition).toHaveBeenCalledWith('clear')
      }
      expect(harness.http.exchange).toHaveBeenCalledTimes(1)
      expect(harness.http.logout).not.toHaveBeenCalled()
      expect(harness.store.commitCredential).not.toHaveBeenCalled()
      if (!isLocalClean) {
        await expect(coordinator.beginLogin('discord')).resolves.toMatchObject({
          ok: false,
          error: { code: 'AUTH_BUSY' }
        })
        await coordinator.retryAuth()
        expect(coordinator.getSnapshot().phase).toBe('signedOut')
      }
    }
  )

  it.each([
    ['confirmed', 'exchange-invalid'],
    ['unknown', 'exchange-invalid'],
    ['confirmed', 'network'],
    ['unknown', 'invalid-response']
  ] as const)(
    'exchange cleanup 실패 중 active logout이 최종 clear=%s, 오류=%s를 소유한다',
    async (logoutClearOutcome, errorCode) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      await beginWaitingLogin(coordinator)
      harness.http.exchange.mockRejectedValueOnce(new AuthHttpFailure(errorCode))
      const rejectedClear = deferred<'failed'>()
      const logoutClear = deferred<'confirmed' | 'unknown'>()
      harness.store.clearWaits.push(rejectedClear.promise, logoutClear.promise)
      const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
      await vi.waitFor(() => expect(harness.store.clearCredential).toHaveBeenCalledTimes(1))

      const loggingOut = coordinator.logout()
      rejectedClear.resolve('failed')
      await vi.waitFor(() => expect(harness.store.clearCredential).toHaveBeenCalledTimes(2))
      expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signingOut', notice: null })
      expect(coordinator.logout()).toBe(loggingOut)
      logoutClear.resolve(logoutClearOutcome)
      await returning
      const result = await loggingOut

      const isLocalClean = logoutClearOutcome === 'confirmed'
      const isExplicitRejection = errorCode === 'exchange-invalid'
      const serverNotice = isExplicitRejection ? null : 'LOGOUT_SERVER_UNCONFIRMED'
      expect(result.snapshot).toMatchObject({
        phase: isLocalClean ? 'signedOut' : 'storageBlocked',
        notice: isLocalClean ? serverNotice : 'LOCAL_CLEAR_UNCONFIRMED'
      })
      expect(harness.store.transitionMarker).toBe(isLocalClean ? null : 'clear')
      expect(harness.http.logout).not.toHaveBeenCalled()
      expect(harness.store.clearCredential).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    ['cancel', 'failed'],
    ['cancel', 'unknown'],
    ['expiry', 'failed'],
    ['expiry', 'unknown'],
    ['cancel', 'confirmed'],
    ['logout', 'failed']
  ] as const)(
    'stale exchange marker 준비 중 %s, 재확립=%s는 local 저장 결과를 보존한다',
    async (invalidation, reestablishOutcome) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      await beginWaitingLogin(coordinator)
      const establishing = deferred<'unknown'>()
      harness.store.establishWaits.push(establishing.promise)
      harness.store.reestablishOutcomes.push(reestablishOutcome)
      const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
      await vi.waitFor(() => expect(harness.store.establishTransition).toHaveBeenCalledTimes(1))
      // 결과 불명 IO가 실제 marker를 남겼을 가능성을 fake에 반영한다.
      harness.store.inspection = { status: 'recovery-required' }

      const isCancelled = invalidation === 'cancel'
      const isLogout = invalidation === 'logout'
      let loggingOut: ReturnType<typeof coordinator.logout> | undefined
      if (isCancelled) {
        await coordinator.cancelLogin(ATTEMPT_ID)
      } else if (isLogout) {
        loggingOut = coordinator.logout()
      } else {
        harness.clock.advance(600_000)
      }
      establishing.resolve('unknown')
      await returning
      await loggingOut
      await settle()

      const isReestablished = reestablishOutcome === 'confirmed'
      const isLocalClean = isReestablished || isLogout
      const invalidationNotice = isCancelled ? 'LOGIN_CANCELLED' : 'LOGIN_EXPIRED'
      const cleanNotice = isLogout ? null : invalidationNotice
      expect(coordinator.getSnapshot()).toMatchObject({
        phase: isLocalClean ? 'signedOut' : 'storageBlocked',
        notice: isLocalClean ? cleanNotice : 'LOCAL_CLEAR_UNCONFIRMED',
        login: null,
        user: null
      })
      expect(harness.store.inspection).toEqual({
        status: isLocalClean ? 'empty' : 'recovery-required'
      })
      expect(harness.http.exchange).not.toHaveBeenCalled()
      expect(harness.http.logout).not.toHaveBeenCalled()
      expect(harness.store.commitCredential).not.toHaveBeenCalled()
    }
  )

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
      const isReestablished = reestablished === 'confirmed'
      const expectedInspection = isReestablished
        ? { status: 'recovery-required' as const }
        : { status: 'ready' as const, refreshToken: REFRESH_1 }
      expect(harness.store.inspection).toEqual(expectedInspection)
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

  it.each([
    ['commit', 'expired'],
    ['finalize', 'discontinuous']
  ] as const)(
    '초기 restore의 %s 대기 뒤 %s이면 확정 R1을 보존하고 시간 문제 retry로 멈춘다',
    async (stage, clockFailure) => {
      const harness = createAuthHarness()
      harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
      const storage = deferred<'confirmed'>()
      const isCommit = stage === 'commit'
      if (isCommit) {
        harness.store.commitWaits.push(storage.promise)
      } else {
        harness.store.removeWaits.push(storage.promise)
      }
      const coordinator = createAuthCoordinator(harness.dependencies)

      const starting = coordinator.start()
      const blockedMutation = isCommit
        ? harness.store.commitCredential
        : harness.store.removeTransition
      await vi.waitFor(() => expect(blockedMutation).toHaveBeenCalledTimes(1))

      const isExpired = clockFailure === 'expired'
      if (isExpired) {
        harness.clock.elapseWithoutTimers(16 * 60_000)
      } else {
        harness.clock.discontinuous = true
      }
      storage.resolve('confirmed')
      await starting

      expect(coordinator.getSnapshot()).toMatchObject({
        phase: 'restorePaused',
        notice: 'RESTORE_RETRY_REQUIRED',
        user: null,
        entry: null
      })
      expect(harness.http.refresh).toHaveBeenCalledTimes(1)
      expect(harness.http.me).not.toHaveBeenCalled()
      expect(harness.http.logout).not.toHaveBeenCalled()
      expect(harness.store.clearCredential).not.toHaveBeenCalled()
      expect(harness.store.inspection).toEqual({ status: 'ready', refreshToken: REFRESH_1 })
    }
  )

  it('restore /me 응답 뒤 clock 신뢰를 잃으면 user를 발행하지 않고 다음 retry에서 R1을 rotation한다', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    const response = deferred<Awaited<ReturnType<typeof harness.http.value.me>>>()
    harness.http.me.mockImplementationOnce(() => response.promise)
    const coordinator = createAuthCoordinator(harness.dependencies)

    const starting = coordinator.start()
    await vi.waitFor(() => expect(harness.http.me).toHaveBeenCalledTimes(1))
    harness.clock.discontinuous = true
    response.resolve({ user: { id: USER_ID, nickname: '모험가000001' } })
    await starting

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'restorePaused',
      notice: 'RESTORE_RETRY_REQUIRED'
    })
    expect(harness.store.inspection).toEqual({ status: 'ready', refreshToken: REFRESH_1 })

    harness.clock.discontinuous = false
    harness.http.refresh.mockResolvedValueOnce(
      tokenResponse({ refreshToken: REFRESH_2, accessToken: ACCESS_2 })
    )
    await coordinator.retryAuth()

    expect(harness.http.refresh).toHaveBeenCalledTimes(2)
    expect(harness.http.refresh).toHaveBeenLastCalledWith(REFRESH_1, expect.any(AbortSignal))
    expect(harness.http.me).toHaveBeenCalledTimes(2)
    expect(harness.http.me).toHaveBeenLastCalledWith(ACCESS_2, expect.any(AbortSignal))
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedIn', entry: 'home' })
  })

  it('retry 첫 clock 신뢰 상실 뒤 전송 전 refresh가 멈추면 network pause를 유지하고 /me를 재개하지 않는다', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    harness.http.me.mockRejectedValueOnce(new AuthHttpFailure('network'))
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()

    const normalReading = harness.clock.read()
    const readClock = vi.spyOn(harness.clock, 'read')
    readClock
      .mockReturnValueOnce({ ...normalReading, discontinuous: true })
      .mockReturnValue(normalReading)
    harness.http.refresh.mockRejectedValueOnce(new AuthHttpFailure('network', 'not-sent'))

    await coordinator.retryAuth()

    expect(harness.http.refresh).toHaveBeenCalledTimes(2)
    expect(harness.http.me).toHaveBeenCalledTimes(1)
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'restorePaused',
      notice: 'NETWORK_UNAVAILABLE'
    })
    readClock.mockRestore()
  })

  it('commit 경계의 clock 신뢰 상실은 finalize 뒤 정상 clock으로 돌아와도 restore를 pause한다', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    const commit = deferred<'confirmed'>()
    const finalize = deferred<'confirmed'>()
    harness.store.commitWaits.push(commit.promise)
    harness.store.removeWaits.push(finalize.promise)
    const coordinator = createAuthCoordinator(harness.dependencies)

    const starting = coordinator.start()
    await vi.waitFor(() => expect(harness.store.commitCredential).toHaveBeenCalledTimes(1))
    harness.clock.discontinuous = true
    commit.resolve('confirmed')
    await vi.waitFor(() => expect(harness.store.removeTransition).toHaveBeenCalledTimes(1))
    harness.clock.discontinuous = false
    finalize.resolve('confirmed')
    await starting

    expect(harness.http.me).not.toHaveBeenCalled()
    expect(harness.store.inspection).toEqual({ status: 'ready', refreshToken: REFRESH_1 })
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'restorePaused',
      notice: 'RESTORE_RETRY_REQUIRED'
    })
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

  it('이전 verification finally는 listener가 재개한 새 요청의 abort 소유권을 지우지 않는다', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    const verifying = deferred<Awaited<ReturnType<typeof harness.http.value.me>>>()
    harness.http.me
      .mockRejectedValueOnce(new AuthHttpFailure('network'))
      .mockImplementationOnce(() => verifying.promise)
    const coordinator = createAuthCoordinator(harness.dependencies)
    const retries: ReturnType<typeof coordinator.retryAuth>[] = []
    const unsubscribe = coordinator.subscribe((snapshot) => {
      const isPaused = snapshot.phase === 'restorePaused'
      if (isPaused) {
        unsubscribe()
        retries.push(coordinator.retryAuth())
      }
    })
    await coordinator.start()
    expect(harness.http.me).toHaveBeenCalledTimes(2)
    const signal = harness.http.me.mock.calls[1][1]

    const logout = coordinator.logout()

    expect(signal.aborted).toBe(true)
    verifying.resolve({ user: { id: USER_ID, nickname: '모험가000001' } })
    await Promise.all([...retries, logout])
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', user: null })
  })

  it('retry의 access 단계는 restoring 알림 뒤 clock으로 선택한다', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    harness.http.me.mockRejectedValueOnce(new AuthHttpFailure('network'))
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    harness.http.refresh.mockResolvedValueOnce(
      tokenResponse({
        refreshToken: REFRESH_2,
        accessToken: ACCESS_2,
        accessTokenExpiresAt: '2026-09-06T12:30:00.000Z'
      })
    )
    const unsubscribe = coordinator.subscribe((snapshot) => {
      const isRestoring = snapshot.phase === 'restoring'
      if (isRestoring) {
        harness.clock.advance(16 * 60_000)
      }
    })

    await coordinator.retryAuth()

    expect(harness.http.refresh).toHaveBeenCalledTimes(2)
    expect(harness.http.refresh).toHaveBeenLastCalledWith(REFRESH_1, expect.any(AbortSignal))
    expect(harness.http.me).toHaveBeenLastCalledWith(ACCESS_2, expect.any(AbortSignal))
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedIn', entry: 'home' })
    unsubscribe()
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

  it.each(['current', 'expired', 'not-sent'] as const)(
    'restore retry의 %s credential은 restoring listener logout 후 effect를 시작하지 않는다',
    async (credentialState) => {
      const harness = createAuthHarness()
      harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
      const wasNotSent = credentialState === 'not-sent'
      if (wasNotSent) {
        harness.http.refresh.mockRejectedValueOnce(new AuthHttpFailure('network', 'not-sent'))
      } else {
        harness.http.me.mockRejectedValueOnce(new AuthHttpFailure('network'))
      }
      const coordinator = createAuthCoordinator(harness.dependencies)
      await coordinator.start()
      expect(coordinator.getSnapshot().phase).toBe('restorePaused')
      const isExpired = credentialState === 'expired'
      if (isExpired) {
        harness.clock.advance(16 * 60_000)
      }
      const logoutClear = deferred<'confirmed'>()
      harness.store.clearWaits.push(logoutClear.promise)
      const loggingOut: ReturnType<typeof coordinator.logout>[] = []
      const unsubscribe = coordinator.subscribe((snapshot) => {
        const isRestoring = snapshot.phase === 'restoring'
        if (isRestoring) {
          unsubscribe()
          loggingOut.push(coordinator.logout())
        }
      })

      await coordinator.retryAuth()
      await vi.waitFor(() => expect(harness.store.clearCredential).toHaveBeenCalledTimes(1))

      expect(harness.http.refresh).toHaveBeenCalledTimes(1)
      expect(harness.http.me).toHaveBeenCalledTimes(wasNotSent ? 0 : 1)
      expect(harness.store.establishTransition.mock.calls).toEqual([['refresh'], ['clear']])
      expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signingOut', user: null })
      await expect(coordinator.authorization()).resolves.toEqual({ status: 'unavailable' })
      logoutClear.resolve('confirmed')
      await Promise.all(loggingOut)
      expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', user: null })
      expect(harness.store.inspection).toEqual({ status: 'empty' })
    }
  )

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

    refresh.resolve(
      tokenResponse({
        refreshToken: REFRESH_2,
        accessToken: ACCESS_2,
        accessTokenExpiresAt: '2026-09-06T12:31:00.000Z'
      })
    )
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(firstResult).toMatchObject({ status: 'available', accessToken: ACCESS_2 })
    expect(harness.store.commitCredential).toHaveBeenCalledTimes(1)
  })

  it.each(['commit-expired', 'finalize-discontinuous'] as const)(
    '저장 후 authorization은 %s이면 확정 credential을 보존하고 unavailable을 공유한다',
    async (boundary) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await restoreSignedIn(coordinator, harness)
      const signedIn = coordinator.getSnapshot()
      harness.clock.advance(16 * 60_000)
      harness.http.refresh.mockClear()
      harness.store.commitCredential.mockClear()
      harness.store.removeTransition.mockClear()
      harness.http.refresh.mockResolvedValueOnce(
        tokenResponse({
          refreshToken: REFRESH_2,
          accessToken: ACCESS_2,
          accessTokenExpiresAt: '2026-09-06T12:31:00.000Z'
        })
      )
      const storage = deferred<'confirmed'>()
      const expiresDuringCommit = boundary === 'commit-expired'
      if (expiresDuringCommit) {
        harness.store.commitWaits.push(storage.promise)
      } else {
        harness.store.removeWaits.push(storage.promise)
      }

      const first = coordinator.authorization()
      const second = coordinator.authorization()
      const blockedMutation = expiresDuringCommit
        ? harness.store.commitCredential
        : harness.store.removeTransition
      await vi.waitFor(() => expect(blockedMutation).toHaveBeenCalledTimes(1))
      expect(harness.http.refresh).toHaveBeenCalledTimes(1)
      if (expiresDuringCommit) {
        harness.clock.elapseWithoutTimers(15 * 60_000)
      } else {
        harness.clock.discontinuous = true
      }
      storage.resolve('confirmed')
      const [firstResult, secondResult] = await Promise.all([first, second])

      expect(firstResult).toBe(secondResult)
      expect(firstResult).toEqual({ status: 'unavailable' })
      expect(coordinator.getSnapshot()).toEqual(signedIn)
      expect(harness.store.inspection).toEqual({ status: 'ready', refreshToken: REFRESH_2 })
      expect(harness.store.clearCredential).not.toHaveBeenCalled()
      expect(harness.http.logout).not.toHaveBeenCalled()
      expect(harness.http.refresh).toHaveBeenCalledTimes(1)

      const nextRefresh = Buffer.alloc(32, 14).toString('base64url')
      const nextExpiry = new Date(harness.clock.wallMs + 15 * 60_000).toISOString()
      harness.http.refresh.mockResolvedValueOnce(
        tokenResponse({
          refreshToken: nextRefresh,
          accessToken: ACCESS_1,
          accessTokenExpiresAt: nextExpiry
        })
      )
      const nextAuthorization = coordinator.authorization()
      harness.clock.discontinuous = false
      const nextResult = await nextAuthorization

      expect(nextResult).toMatchObject({ status: 'available', accessToken: ACCESS_1 })
      expect(harness.http.refresh).toHaveBeenCalledTimes(2)
      expect(harness.http.refresh).toHaveBeenLastCalledWith(REFRESH_2, expect.any(AbortSignal))
      expect(harness.store.inspection).toEqual({ status: 'ready', refreshToken: nextRefresh })
      expect(coordinator.getSnapshot()).toEqual(signedIn)
      expect(harness.store.clearCredential).not.toHaveBeenCalled()
      expect(harness.http.logout).not.toHaveBeenCalled()
    }
  )

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

    refresh.resolve(
      tokenResponse({
        refreshToken: REFRESH_2,
        accessToken: ACCESS_2,
        accessTokenExpiresAt: '2026-09-06T12:31:00.000Z'
      })
    )
    const [authorizationResult] = await Promise.all([authorization, logout])
    expect(authorizationResult).toEqual({ status: 'unavailable' })
    expect(harness.store.commitCredential).not.toHaveBeenCalled()
    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', user: null })
  })

  it.each(['commit', 'finalize', 'reestablish'] as const)(
    'refresh %s 실패의 credential 폐기 대기 중 logout이 최종 cleanup을 소유한다',
    async (failureStage) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await restoreSignedIn(coordinator, harness)
      harness.clock.advance(16 * 60_000)
      harness.http.refresh.mockResolvedValueOnce(
        tokenResponse({
          refreshToken: REFRESH_2,
          accessToken: ACCESS_2,
          accessTokenExpiresAt: '2026-09-06T12:31:00.000Z'
        })
      )
      const isCommitFailure = failureStage === 'commit'
      const isReestablishFailure = failureStage === 'reestablish'
      if (isCommitFailure) {
        harness.store.commitOutcomes.push('failed')
      } else {
        harness.store.removeOutcomes.push('unknown')
        harness.store.unknownRemoveApplied.push(true)
        if (isReestablishFailure) {
          harness.store.reestablishOutcomes.push('failed')
        }
      }
      const disposal = deferred<void>()
      harness.http.logout.mockImplementationOnce(() => disposal.promise)

      const authorization = coordinator.authorization()
      await vi.waitFor(() => expect(harness.http.logout).toHaveBeenCalledTimes(1))
      expect(harness.http.logout).toHaveBeenNthCalledWith(1, REFRESH_2, expect.any(AbortSignal))
      const logout = coordinator.logout()
      expect(coordinator.getSnapshot().phase).toBe('signingOut')
      expect(harness.http.logout).toHaveBeenNthCalledWith(2, REFRESH_1, expect.any(AbortSignal))
      disposal.resolve()
      const [authorizationResult, logoutResult] = await Promise.all([authorization, logout])

      expect(authorizationResult).toEqual({ status: 'unavailable' })
      expect(logoutResult.snapshot).toMatchObject({ phase: 'signedOut', notice: null })
      expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', notice: null })
      expect(harness.store.inspection).toEqual({ status: 'empty' })
      expect(harness.http.logout).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['confirmed', 'failed'] as const)(
    '전송 전 refresh 실패의 marker 제거 %s 대기 중 logout 상태를 덮지 않는다',
    async (removeOutcome) => {
      const harness = createAuthHarness()
      harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
      harness.http.refresh.mockRejectedValueOnce(new AuthHttpFailure('network', 'not-sent'))
      const remove = deferred<'confirmed' | 'failed'>()
      harness.store.removeWaits.push(remove.promise)
      const coordinator = createAuthCoordinator(harness.dependencies)
      const phases: string[] = []
      coordinator.subscribe((snapshot) => phases.push(snapshot.phase))

      const starting = coordinator.start()
      await vi.waitFor(() => expect(harness.store.removeTransition).toHaveBeenCalledTimes(1))
      const logout = coordinator.logout()
      remove.resolve(removeOutcome)
      await Promise.all([starting, logout])

      expect(phases).toEqual(['signingOut', 'signedOut'])
      expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', notice: null })
      expect(harness.store.inspection).toEqual({ status: 'empty' })
      expect(harness.http.logout).toHaveBeenCalledTimes(1)
    }
  )

  it('refresh 새 token 폐기 실패도 known 이전 token logout 204로 같은 session 폐기를 확인한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await restoreSignedIn(coordinator, harness)
    harness.clock.advance(16 * 60_000)
    harness.store.commitOutcomes.push('failed')
    harness.http.refresh.mockResolvedValueOnce(tokenResponse({ refreshToken: REFRESH_2 }))
    const disposal = deferred<void>()
    harness.http.logout.mockImplementationOnce(() => disposal.promise)

    const authorization = coordinator.authorization()
    await vi.waitFor(() => expect(harness.http.logout).toHaveBeenCalledTimes(1))
    const logout = coordinator.logout()
    disposal.reject(new AuthHttpFailure('unavailable'))
    await Promise.all([authorization, logout])

    expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', notice: null })
    expect(harness.store.inspection).toEqual({ status: 'empty' })
    expect(harness.http.logout).toHaveBeenCalledTimes(2)
    expect(harness.http.logout).toHaveBeenNthCalledWith(1, REFRESH_2, expect.any(AbortSignal))
    expect(harness.http.logout).toHaveBeenNthCalledWith(2, REFRESH_1, expect.any(AbortSignal))
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

  it.each([
    ['disposal', true],
    ['local-clear', true],
    ['disposal', false],
    ['local-clear', false]
  ] as const)(
    '전송된 refresh 실패의 %s 대기 중 access 만료=%s여도 authorization과 새 writer를 차단한다',
    async (waitingStage, hasExpiredAccess) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await restoreSignedIn(coordinator, harness)
      if (hasExpiredAccess) {
        harness.clock.advance(16 * 60_000)
      } else {
        harness.clock.discontinuous = true
      }
      harness.http.refresh.mockClear()
      harness.store.commitCredential.mockClear()
      harness.store.establishTransition.mockClear()
      harness.http.refresh.mockRejectedValueOnce(new AuthHttpFailure('network', 'unknown'))
      const disposal = deferred<void>()
      const localClear = deferred<'confirmed'>()
      const isWaitingDisposal = waitingStage === 'disposal'
      if (isWaitingDisposal) {
        harness.http.logout.mockImplementationOnce(() => disposal.promise)
      } else {
        harness.store.clearWaits.push(localClear.promise)
      }

      const first = coordinator.authorization()
      await settle()
      harness.clock.discontinuous = false
      const concurrent = coordinator.authorization()
      await settle()

      expect(harness.http.refresh).toHaveBeenCalledTimes(1)
      await expect(concurrent).resolves.toEqual({ status: 'unavailable' })
      expect(coordinator.getSnapshot().phase).not.toBe('signedIn')
      expect(coordinator.getSnapshot().user).toBeNull()
      expect(harness.store.commitCredential).not.toHaveBeenCalled()
      expect(harness.store.establishTransition.mock.calls).toEqual(
        isWaitingDisposal ? [['refresh']] : [['refresh'], ['clear']]
      )
      await expect(coordinator.beginLogin('google')).resolves.toMatchObject({
        ok: false,
        error: { code: 'AUTH_BUSY' }
      })

      disposal.resolve()
      localClear.resolve('confirmed')
      await expect(first).resolves.toEqual({ status: 'unavailable' })
      expect(coordinator.getSnapshot()).toMatchObject({
        phase: 'signedOut',
        notice: 'REAUTH_REQUIRED'
      })
      expect(harness.http.logout).toHaveBeenCalledTimes(1)
      expect(harness.store.inspection).toEqual({ status: 'empty' })
    }
  )

  it.each(['confirmed', 'unknown'] as const)(
    '실패 refresh 폐기 중 logout은 같은 요청을 공유하고 local clear=%s 결과를 보존한다',
    async (clearOutcome) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await restoreSignedIn(coordinator, harness)
      harness.clock.advance(16 * 60_000)
      harness.http.refresh.mockClear()
      harness.http.refresh.mockRejectedValueOnce(new AuthHttpFailure('authentication-required'))
      const disposal = deferred<void>()
      harness.http.logout.mockImplementationOnce(() => disposal.promise)
      harness.store.clearOutcomes.push(clearOutcome)

      const authorization = coordinator.authorization()
      await settle()
      const logout = coordinator.logout()
      await settle()

      await expect(coordinator.authorization()).resolves.toEqual({ status: 'unavailable' })
      expect(harness.http.logout).toHaveBeenCalledTimes(1)
      expect(harness.http.logout).toHaveBeenCalledWith(REFRESH_1, expect.any(AbortSignal))
      disposal.reject(new AuthHttpFailure('unavailable'))
      const [authorizationResult, logoutResult] = await Promise.all([authorization, logout])

      const isLocalClearConfirmed = clearOutcome === 'confirmed'
      expect(authorizationResult).toEqual({ status: 'unavailable' })
      expect(logoutResult.snapshot).toMatchObject({
        phase: isLocalClearConfirmed ? 'signedOut' : 'storageBlocked',
        notice: isLocalClearConfirmed ? 'LOGOUT_SERVER_UNCONFIRMED' : 'LOCAL_CLEAR_UNCONFIRMED'
      })
      expect(harness.http.refresh).toHaveBeenCalledTimes(1)
      expect(harness.http.logout).toHaveBeenCalledTimes(1)
      expect(harness.store.clearCredential).toHaveBeenCalledTimes(1)
    }
  )

  it('refresh 401/결과 불명은 R0를 다시 쓰지 않고 clear 뒤 재로그인을 요구한다', async () => {
    for (const failure of [
      new AuthHttpFailure('authentication-required'),
      new AuthHttpFailure('network', 'unknown'),
      new AuthHttpFailure('unavailable'),
      new AuthHttpFailure('invalid-response')
    ]) {
      const harness = createAuthHarness()
      harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
      harness.http.refresh.mockRejectedValueOnce(failure)
      const coordinator = createAuthCoordinator(harness.dependencies)

      await coordinator.start()

      expect(harness.http.refresh).toHaveBeenCalledTimes(1)
      expect(harness.http.refresh).toHaveBeenCalledWith(REFRESH_0, expect.any(AbortSignal))
      expect(harness.http.logout).toHaveBeenCalledTimes(1)
      expect(harness.http.logout).toHaveBeenCalledWith(REFRESH_0, expect.any(AbortSignal))
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

  it.each(['once', 'persistent'] as const)(
    'signingOut의 %s listener가 logout에 재진입해도 같은 flight와 단일 정리를 공유한다',
    async (listenerMode) => {
      const harness = createAuthHarness()
      const coordinator = createAuthCoordinator(harness.dependencies)
      await restoreSignedIn(coordinator, harness)
      harness.store.establishTransition.mockClear()
      harness.store.removeTransition.mockClear()
      const serverLogout = deferred<void>()
      harness.http.logout.mockImplementationOnce(() => serverLogout.promise)
      const reentrant: ReturnType<typeof coordinator.logout>[] = []
      let signingOutCount = 0
      const isPersistent = listenerMode === 'persistent'
      const unsubscribe = coordinator.subscribe((snapshot) => {
        const isSigningOut = snapshot.phase === 'signingOut'
        if (!isSigningOut) {
          return
        }
        signingOutCount += 1
        const isFirstNotification = signingOutCount === 1
        // Red에서 stack overflow 대신 반복 publication을 유한하게 관측한다.
        const isWithinRecursionLimit = signingOutCount <= 8
        const shouldJoin = (isPersistent || isFirstNotification) && isWithinRecursionLimit
        if (shouldJoin) {
          reentrant.push(coordinator.logout())
        }
      })

      const logout = coordinator.logout()
      expect(coordinator.getSnapshot().phase).toBe('signingOut')
      await expect(coordinator.authorization()).resolves.toEqual({ status: 'unavailable' })
      await expect(coordinator.beginLogin('google')).resolves.toMatchObject({
        ok: false,
        error: { code: 'AUTH_BUSY' }
      })
      await settle()
      serverLogout.resolve()
      const results = await Promise.all([logout, ...reentrant])

      expect(signingOutCount).toBe(1)
      expect(reentrant).toHaveLength(1)
      expect(reentrant[0]).toBe(logout)
      expect(results[1]).toBe(results[0])
      expect(harness.store.establishTransition.mock.calls).toEqual([['clear']])
      expect(harness.http.logout).toHaveBeenCalledTimes(1)
      expect(harness.store.clearCredential).toHaveBeenCalledTimes(1)
      expect(harness.store.removeTransition).toHaveBeenCalledTimes(1)
      expect(coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', notice: null })
      unsubscribe()
      await beginWaitingLogin(coordinator)
    }
  )

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
