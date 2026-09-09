import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthCoordinator } from '../coordinator'
import {
  ATTEMPT_ID,
  CODE,
  RETURN_TARGET,
  createAuthHarness,
  deferred as responseDeferred,
  tokenResponse
} from '../auth-test-fixtures'
import { REFRESH_1, createStoreFixture, deferred } from './credential-store-test-fixture'
import type { StoreFixture } from './credential-store-test-fixture'
import type { LoginExchangeResponse } from '../types'

describe('macOS adapter와 기존 coordinator writer 경계', () => {
  let fixture: StoreFixture

  beforeEach(async () => {
    fixture = await createStoreFixture()
  })

  afterEach(async () => {
    const leakedHandles = fixture.openHandles.size
    await fixture.cleanup()
    expect(leakedHandles).toBe(0)
  })

  it('저장 중 취소는 이전 writer 정리 전 새 login을 막고 늦은 저장을 제거한다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator({ ...harness.dependencies, store: fixture.store })
    const flushing = deferred()
    fixture.waits.set('sync:credential-temp', [flushing.promise])
    await coordinator.start()
    await coordinator.beginLogin('google')
    await vi.waitFor(() => expect(coordinator.getSnapshot().phase).toBe('waitingBrowser'))
    const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    await vi.waitFor(() => expect(fixture.events).toContain('sync:credential-temp'))

    await coordinator.cancelLogin(ATTEMPT_ID)
    expect(await coordinator.beginLogin('google')).toMatchObject({
      ok: false,
      error: { code: 'AUTH_BUSY' }
    })
    flushing.resolve()
    await returning

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_CANCELLED'
    })
    expect(await fixture.createStore().inspect()).toEqual({ status: 'empty' })
    expect(harness.http.logout).toHaveBeenCalledTimes(1)
    expect(await coordinator.beginLogin('google')).toMatchObject({ ok: true })
  })

  it('exchange 취소 뒤 늦은 성공은 adapter에 쓰지 않고 알려진 token만 폐기한다', async () => {
    const harness = createAuthHarness()
    const response = responseDeferred<LoginExchangeResponse>()
    harness.http.exchange.mockReturnValueOnce(response.promise)
    const coordinator = createAuthCoordinator({ ...harness.dependencies, store: fixture.store })
    await coordinator.start()
    await coordinator.beginLogin('google')
    await vi.waitFor(() => expect(coordinator.getSnapshot().phase).toBe('waitingBrowser'))
    const returning = coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    await vi.waitFor(() => expect(harness.http.exchange).toHaveBeenCalledTimes(1))

    await coordinator.cancelLogin(ATTEMPT_ID)
    response.resolve({
      ...tokenResponse({ refreshToken: REFRESH_1 }),
      user: { id: '00000000-0000-4000-8000-000000000031', nickname: '합성사용자' },
      isNewUser: false
    })
    await returning

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_CANCELLED'
    })
    expect(fixture.events).not.toContain('write:credential-temp')
    expect(harness.http.logout).toHaveBeenCalledWith(REFRESH_1, expect.any(AbortSignal))
    expect(await fixture.createStore().inspect()).toEqual({ status: 'empty' })
  })
})
