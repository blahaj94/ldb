import { describe, expect, it, vi } from 'vitest'
import { CredentialSession } from './credential-session'
import { PendingLogin } from './pending-login'
import {
  REQUEST_ID,
  REFRESH_0,
  REFRESH_1,
  REFRESH_2,
  createAuthHarness,
  deferred
} from './auth-test-fixtures'
import type { AuthAuthorization, ClockReading } from './types'

describe('CredentialSession condition boundaries', () => {
  it('같은 generation의 refresh flight만 기존 Promise를 공유한다', async () => {
    const harness = createAuthHarness()
    const session = new CredentialSession(harness.http.value, harness.store)
    const first = deferred<AuthAuthorization>()
    const second = deferred<AuthAuthorization>()
    const startFirst = vi.fn(() => first.promise)
    const startSecond = vi.fn(() => second.promise)

    const firstFlight = session.shareRefresh(1, startFirst)
    expect(session.currentRefresh(1)).toBe(firstFlight)
    expect(session.currentRefresh(2)).toBeNull()

    const joinedFlight = session.shareRefresh(1, startSecond)
    expect(joinedFlight).toBe(firstFlight)
    expect(startSecond).not.toHaveBeenCalled()

    const nextFlight = session.shareRefresh(2, startSecond)
    expect(nextFlight).not.toBe(firstFlight)
    expect(session.currentRefresh(1)).toBeNull()
    expect(session.currentRefresh(2)).toBe(nextFlight)
    expect(startFirst).toHaveBeenCalledTimes(1)
    expect(startSecond).toHaveBeenCalledTimes(1)

    first.resolve({ status: 'unavailable' })
    second.resolve({ status: 'unavailable' })
    await Promise.all([firstFlight, nextFlight])
    expect(session.currentRefresh(2)).toBeNull()
  })

  it('같은 refresh token의 disposal flight만 기존 Promise를 공유한다', async () => {
    const harness = createAuthHarness()
    const session = new CredentialSession(harness.http.value, harness.store)
    const firstLogout = deferred<void>()
    const secondLogout = deferred<void>()
    harness.http.logout
      .mockReturnValueOnce(firstLogout.promise)
      .mockReturnValueOnce(secondLogout.promise)

    const firstFlight = session.dispose(REFRESH_1)
    const joinedFlight = session.dispose(REFRESH_1)
    expect(joinedFlight).toBe(firstFlight)
    expect(harness.http.logout).toHaveBeenCalledTimes(1)

    const nextFlight = session.dispose(REFRESH_2)
    expect(nextFlight).not.toBe(firstFlight)
    expect(harness.http.logout).toHaveBeenCalledTimes(2)
    expect(harness.http.logout.mock.calls.map(([refreshToken]) => refreshToken)).toEqual([
      REFRESH_1,
      REFRESH_2
    ])

    firstLogout.resolve()
    secondLogout.resolve()
    await Promise.all([firstFlight, nextFlight])
  })

  it('server expiry가 없으면 해당 비교를 위한 clock property를 추가로 읽지 않는다', () => {
    const harness = createAuthHarness()
    const startedAt = harness.clock.read()
    const pending = new PendingLogin(
      {
        attemptId: '00000000-0000-4000-8000-000000000010',
        provider: 'google',
        verifier: 'verifier',
        generation: 1,
        startedAt
      },
      harness.clock,
      vi.fn()
    )
    let wallReads = 0
    const checkedAt: ClockReading = {
      get wallMs() {
        wallReads += 1
        if (wallReads > 1) {
          throw new Error('server expiry must not read wallMs without an expiry')
        }
        return startedAt.wallMs + 1
      },
      monotonicMs: startedAt.monotonicMs + 1,
      discontinuous: false
    }

    expect(pending.isExpired(checkedAt)).toBe(false)
    expect(wallReads).toBe(1)
  })

  it('server expiry 비교는 clock 조건과 startedAt.discontinuous보다 앞선 원래 순서를 유지한다', () => {
    const harness = createAuthHarness()
    const events: string[] = []
    const startedWallMs = harness.clock.wallMs
    const startedMonotonicMs = harness.clock.monotonicMs
    const startedAt: ClockReading = {
      get wallMs() {
        events.push('started.wallMs')
        return startedWallMs
      },
      get monotonicMs() {
        events.push('started.monotonicMs')
        return startedMonotonicMs
      },
      get discontinuous() {
        events.push('started.discontinuous')
        return false
      }
    }
    const checkedAt: ClockReading = {
      get wallMs() {
        events.push('checked.wallMs')
        return startedWallMs + 600_000
      },
      get monotonicMs() {
        events.push('checked.monotonicMs')
        return startedMonotonicMs + 1
      },
      get discontinuous() {
        events.push('checked.discontinuous')
        return false
      }
    }
    const pending = new PendingLogin(
      {
        attemptId: '00000000-0000-4000-8000-000000000011',
        provider: 'google',
        verifier: 'verifier',
        generation: 1,
        startedAt
      },
      harness.clock,
      vi.fn()
    )
    pending.acceptRequest({
      requestId: REQUEST_ID,
      browserUrl: 'https://api.example.test/auth/login/authorize',
      expiresAt: '2026-09-06T12:10:00.000Z'
    })

    expect(pending.isExpired(checkedAt)).toBe(true)
    expect(events).toEqual([
      'checked.wallMs',
      'started.wallMs',
      'checked.monotonicMs',
      'started.monotonicMs',
      'checked.monotonicMs',
      'started.monotonicMs',
      'checked.wallMs',
      'started.discontinuous',
      'checked.discontinuous'
    ])
  })

  it('logout writer의 HTTP 상태 합성과 local clear 단락 및 reservation cleanup을 유지한다', async () => {
    const noWriterHarness = createAuthHarness()
    const noWriterSession = new CredentialSession(noWriterHarness.http.value, noWriterHarness.store)
    expect(noWriterSession.beginLogout().credentialHttpStarted).toBe(false)

    const writerHarness = createAuthHarness()
    const writerSession = new CredentialSession(writerHarness.http.value, writerHarness.store)
    const writer = writerSession.reserveWriter()
    await writerSession.sendRefresh(writer, REFRESH_0)
    expect(writerSession.beginLogout().credentialHttpStarted).toBe(true)

    const logoutHarness = createAuthHarness()
    const logoutSession = new CredentialSession(logoutHarness.http.value, logoutHarness.store)
    logoutSession.retainForRestore(REFRESH_0)
    logoutHarness.store.establishOutcomes.push('failed')
    const reservation = logoutSession.beginLogout()

    await expect(logoutSession.finishLogout(reservation)).resolves.toEqual({
      localConfirmed: false,
      serverConfirmed: true
    })
    expect(logoutHarness.store.clearCredential).not.toHaveBeenCalled()
    expect(logoutSession.knownRefresh).toBeNull()
    expect(logoutSession.beginLogout()).not.toBe(reservation)
  })
})
