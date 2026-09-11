import { describe, expect, it, vi } from 'vitest'
import { createAuthCoordinator } from './coordinator'
import { AuthHttpFailure } from './http'
import { CODE, REFRESH_0, RETURN_TARGET, createAuthHarness } from './auth-test-fixtures'

function observedFailure(
  codes: readonly string[],
  transmission: 'not-sent' | 'unknown' = 'unknown'
): {
  failure: AuthHttpFailure
  reads: string[]
} {
  const failure = new AuthHttpFailure('network', transmission)
  const reads: string[] = []
  let codeRead = 0

  Object.defineProperty(failure, 'code', {
    configurable: true,
    get: () => {
      codeRead += 1
      const code = codes[codeRead - 1] ?? codes[codes.length - 1]
      reads.push(`code:${codeRead}`)
      return code
    }
  })
  Object.defineProperty(failure, 'transmission', {
    configurable: true,
    get: () => {
      reads.push('transmission')
      return transmission
    }
  })

  return { failure, reads }
}

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
  await coordinator.beginLogin('google')
  await waitForPhase(coordinator, 'waitingBrowser')
}

describe('Desktop AuthCoordinator condition boundaries', () => {
  it('login request failure keeps both independent error-code reads', async () => {
    const harness = createAuthHarness()
    const observed = observedFailure(['network', 'unavailable'])
    harness.http.createLoginRequest.mockRejectedValueOnce(observed.failure)
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()

    await coordinator.beginLogin('google')
    await waitForPhase(coordinator, 'signedOut')

    expect(observed.reads).toEqual(['code:1', 'code:2'])
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'NETWORK_UNAVAILABLE'
    })
  })

  it('exchange failure preserves code-before-transmission evaluation', async () => {
    const harness = createAuthHarness()
    const observed = observedFailure(['exchange-invalid', 'network'], 'not-sent')
    harness.http.exchange.mockRejectedValueOnce(observed.failure)
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    await beginWaitingLogin(coordinator)

    await coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)

    expect(observed.reads).toEqual(['code:1', 'code:2', 'transmission'])
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'waitingBrowser',
      notice: 'LOGIN_RETURN_INVALID'
    })
  })

  it('refresh checks transmission only after the network code', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    harness.clock.advance(16 * 60_000)

    const observed = observedFailure(['network'], 'not-sent')
    harness.http.refresh.mockRejectedValueOnce(observed.failure)

    await coordinator.authorization()

    expect(observed.reads).toEqual(['code:1', 'transmission'])
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'restorePaused',
      notice: 'NETWORK_UNAVAILABLE'
    })
  })
})
