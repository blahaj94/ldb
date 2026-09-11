import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createAuthRuntimeEffects } from './runtime-effects'
import { createAuthCoordinator } from './coordinator'
import { AuthHttpFailure } from './http'
import {
  createAuthHarness,
  deferred,
  REFRESH_0,
  REFRESH_1,
  REFRESH_2,
  tokenResponse,
  USER_ID
} from './auth-test-fixtures'

function createRuntimeHarness() {
  const harness = createAuthHarness()
  const time = { wallMs: harness.clock.wallMs, monotonicMs: 1_000, sampleDelayMs: 0 }
  const effects = createAuthRuntimeEffects({
    readWallMs: () => {
      const wallMs = time.wallMs
      time.monotonicMs += time.sampleDelayMs
      time.wallMs += time.sampleDelayMs
      return wallMs
    },
    readMonotonicMs: () => time.monotonicMs,
    createHttp: () => harness.dependencies.http,
    createStore: () => harness.store
  })
  const dependencies = effects.createDependencies({
    apiOrigin: harness.dependencies.apiOrigin,
    returnTarget: harness.dependencies.returnTarget,
    environment: 'test',
    providers: ['google'],
    appIdentity: 'com.synthetic.ldb',
    userDataPath: '/synthetic/user-data'
  })
  const coordinator = createAuthCoordinator(dependencies)
  return { ...harness, time, effects, clock: dependencies.clock, coordinator }
}

describe('runtime clock trust periods', () => {
  it.each([
    [-5_000, true],
    [5_000, true],
    [-1_000, false],
    [1_000, false],
    [1_001, true]
  ])(
    'checks cumulative relative offset %i ms against the fixed budget',
    (offset, discontinuous) => {
      const harness = createRuntimeHarness()
      harness.time.wallMs += 10_000 + offset
      harness.time.monotonicMs += 10_000

      expect(harness.clock.read().discontinuous).toBe(discontinuous)
    }
  )

  it('accumulates small changes and keeps distrust through normal reads and other consumers', () => {
    const harness = createRuntimeHarness()
    const searchClock = harness.effects.createSearchClock()
    for (let index = 0; index < 4; index += 1) {
      harness.time.wallMs += 1_250
      harness.time.monotonicMs += 1_000
      expect(harness.clock.read().discontinuous).toBe(false)
    }
    harness.time.wallMs += 1_250
    harness.time.monotonicMs += 1_000
    expect(searchClock.read().discontinuous).toBe(true)
    expect(harness.clock.read().discontinuous).toBe(true)

    harness.time.wallMs += 1_000
    harness.time.monotonicMs += 1_000
    expect(harness.clock.read().discontinuous).toBe(true)
  })

  it('counts bracket uncertainty inside the budget and rejects a wide sample', () => {
    const harness = createRuntimeHarness()
    harness.time.sampleDelayMs = 10
    expect(harness.clock.read().discontinuous).toBe(false)
    harness.time.sampleDelayMs = 1_001

    expect(harness.clock.read().discontinuous).toBe(true)
    harness.time.sampleDelayMs = 0
    expect(harness.clock.read().discontinuous).toBe(true)
  })

  it('does not add sampling uncertainty on top of the offset budget', () => {
    const harness = createRuntimeHarness()
    harness.time.wallMs += 10_990
    harness.time.monotonicMs += 10_000
    harness.time.sampleDelayMs = 20

    expect(harness.clock.read().discontinuous).toBe(false)
    harness.time.wallMs += 20
    expect(harness.clock.read().discontinuous).toBe(true)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('cannot trust a nonfinite sample %s', (value) => {
    const harness = createRuntimeHarness()
    harness.time.wallMs = value

    expect(harness.clock.read().discontinuous).toBe(true)
  })

  it('latches power events even with equal clock progress and removes its listeners', () => {
    const harness = createRuntimeHarness()
    const powerMonitor = new EventEmitter()
    const dispose = harness.effects.bindPowerMonitor(powerMonitor)
    powerMonitor.emit('suspend')
    harness.time.wallMs += 60_000
    harness.time.monotonicMs += 60_000
    powerMonitor.emit('resume')

    expect(harness.clock.read().discontinuous).toBe(true)
    expect(harness.clock.read().discontinuous).toBe(true)
    dispose()
    dispose()
    expect(powerMonitor.listenerCount('suspend')).toBe(0)
    expect(powerMonitor.listenerCount('resume')).toBe(0)
  })
})

describe('runtime clock and real coordinator', () => {
  it.each(['commit', 'finalize', 'me'] as const)(
    'preserves committed refresh and pauses on relative rollback during %s until one user retry',
    async (stage) => {
      const harness = createRuntimeHarness()
      harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
      const wait = deferred<'confirmed'>()
      const me = deferred<{ user: { id: string; nickname: string } }>()
      const isCommit = stage === 'commit'
      const isFinalize = stage === 'finalize'
      const isMe = stage === 'me'
      if (isCommit) {
        harness.store.commitWaits.push(wait.promise)
      }
      if (isFinalize) {
        harness.store.removeWaits.push(wait.promise)
      }
      if (isMe) {
        harness.http.me.mockImplementationOnce(() => me.promise)
      }
      const start = harness.coordinator.start()
      const boundary = isMe
        ? harness.http.me
        : isFinalize
          ? harness.store.removeTransition
          : harness.store.commitCredential
      await vi.waitFor(() => expect(boundary).toHaveBeenCalledOnce())
      harness.time.wallMs += 5_000
      harness.time.monotonicMs += 10_000
      // A separate consumer observes the event first; later reads must retain it.
      harness.clock.read()
      wait.resolve('confirmed')
      me.resolve({ user: { id: USER_ID, nickname: '모험가000001' } })
      await start

      expect(harness.coordinator.getSnapshot()).toMatchObject({
        phase: 'restorePaused',
        notice: 'RESTORE_RETRY_REQUIRED'
      })
      expect(harness.store.storedRefreshToken).toBe(REFRESH_1)
      expect(harness.store.transitionMarker).toBeNull()
      expect(harness.http.refresh).toHaveBeenCalledTimes(1)
      expect(harness.http.me).toHaveBeenCalledTimes(isMe ? 1 : 0)
      expect(harness.store.clearCredential).not.toHaveBeenCalled()
      expect(harness.http.logout).not.toHaveBeenCalled()

      harness.http.refresh.mockResolvedValueOnce(tokenResponse({ refreshToken: REFRESH_2 }))
      await harness.coordinator.retryAuth()

      expect(harness.http.refresh).toHaveBeenCalledTimes(2)
      expect(harness.http.refresh.mock.calls[1][0]).toBe(REFRESH_1)
      expect(harness.coordinator.getSnapshot().phase).toBe('signedIn')
      expect(harness.store.storedRefreshToken).toBe(REFRESH_2)
    }
  )

  it('does not revive old access when a fresh clock period refresh fails before sending', async () => {
    const harness = createRuntimeHarness()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    await harness.coordinator.start()
    harness.time.wallMs += 5_000
    harness.time.monotonicMs += 10_000
    harness.http.refresh.mockRejectedValueOnce(new AuthHttpFailure('network', 'not-sent'))

    expect(await harness.coordinator.authorization()).toEqual({ status: 'unavailable' })
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      phase: 'restorePaused',
      notice: 'NETWORK_UNAVAILABLE'
    })
    harness.http.refresh.mockResolvedValueOnce(tokenResponse({ refreshToken: REFRESH_2 }))
    await harness.coordinator.retryAuth()

    expect(harness.http.refresh).toHaveBeenCalledTimes(3)
    expect(harness.http.refresh.mock.calls[2][0]).toBe(REFRESH_1)
    expect(harness.http.me).toHaveBeenCalledTimes(2)
  })
})
