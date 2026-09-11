import { describe, expect, it, vi } from 'vitest'
import { bootstrapAuthRuntime } from './bootstrap'
import { createAuthHarness, CODE, REFRESH_0, settle } from './auth-test-fixtures'
import { AuthHttpFailure } from './http'
import type { AuthRuntimeConfig } from './runtime-config'

const config: AuthRuntimeConfig = {
  apiOrigin: 'https://api.example.test',
  returnTarget: 'ldb-test://auth/return',
  environment: 'test',
  providers: ['google', 'discord']
}

describe('desktop auth bootstrap', () => {
  it('completes the access notice before store inspection and coordinator start', async () => {
    const harness = createAuthHarness()
    const operations = harness.operations
    const announceCredentialAccess = vi.fn(async () => {
      operations.push('notice:complete')
    })
    const createDependencies = vi.fn(() => {
      operations.push('dependencies:create')
      return harness.dependencies
    })
    const runtime = await bootstrapAuthRuntime({
      config,
      effects: { announceCredentialAccess, createDependencies }
    })

    expect(runtime?.coordinator.getSnapshot().phase).toBe('signedOut')
    expect(operations).toEqual(['notice:complete', 'dependencies:create', 'store:inspect'])
    expect(announceCredentialAccess).toHaveBeenCalledOnce()
    expect(createDependencies).toHaveBeenCalledOnce()
  })

  it('does not create auth effects when trusted configuration is absent', async () => {
    const announceCredentialAccess = vi.fn(async () => undefined)
    const createDependencies = vi.fn(() => createAuthHarness().dependencies)

    const runtime = await bootstrapAuthRuntime({
      config: null,
      effects: { announceCredentialAccess, createDependencies }
    })

    expect(runtime).toBeNull()
    expect(announceCredentialAccess).not.toHaveBeenCalled()
    expect(createDependencies).not.toHaveBeenCalled()
  })

  it('does not inspect the store when the access notice cannot complete', async () => {
    const harness = createAuthHarness()
    const announceCredentialAccess = vi.fn(async () => {
      throw new Error('synthetic notice failure')
    })
    const createDependencies = vi.fn(() => harness.dependencies)

    const runtime = await bootstrapAuthRuntime({
      config,
      effects: { announceCredentialAccess, createDependencies }
    })

    expect(runtime).toBeNull()
    expect(createDependencies).not.toHaveBeenCalled()
    expect(harness.store.inspect).not.toHaveBeenCalled()
  })

  it('connects a synthetic successful login without using production environment values', async () => {
    const harness = createAuthHarness()
    const runtime = await bootstrapAuthRuntime({
      config,
      effects: {
        announceCredentialAccess: vi.fn(async () => undefined),
        createDependencies: () => harness.dependencies
      }
    })
    if (runtime == null) {
      throw new Error('Synthetic auth runtime should be available')
    }

    const started = await runtime.coordinator.beginLogin('google')
    await settle()
    expect(started).toMatchObject({ ok: true, snapshot: { phase: 'startingLogin' } })
    expect(runtime.coordinator.getSnapshot()).toMatchObject({ phase: 'waitingBrowser' })
    await runtime.coordinator.handleReturnUrl(`${config.returnTarget}?code=${CODE}`)

    expect(runtime.coordinator.getSnapshot()).toMatchObject({
      phase: 'signedIn',
      entry: 'welcome',
      user: { nickname: '모험가000001' },
      notice: null
    })
  })

  it('keeps login failure and restore failure in the existing retry notices', async () => {
    const failedLoginHarness = createAuthHarness()
    failedLoginHarness.http.exchange.mockRejectedValue(new AuthHttpFailure('network'))
    const failedLogin = await bootstrapAuthRuntime({
      config,
      effects: {
        announceCredentialAccess: vi.fn(async () => undefined),
        createDependencies: () => failedLoginHarness.dependencies
      }
    })
    if (failedLogin == null) {
      throw new Error('Synthetic auth runtime should be available')
    }
    await failedLogin.coordinator.beginLogin('google')
    await settle()
    await failedLogin.coordinator.handleReturnUrl(`${config.returnTarget}?code=${CODE}`)
    expect(failedLogin.coordinator.getSnapshot()).toMatchObject({
      phase: 'signedOut',
      notice: 'LOGIN_RESTART_REQUIRED'
    })

    const restoreHarness = createAuthHarness()
    restoreHarness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    restoreHarness.http.me.mockRejectedValue(new AuthHttpFailure('network'))
    const restored = await bootstrapAuthRuntime({
      config,
      effects: {
        announceCredentialAccess: vi.fn(async () => undefined),
        createDependencies: () => restoreHarness.dependencies
      }
    })
    if (restored == null) {
      throw new Error('Synthetic auth runtime should be available')
    }
    expect(restored.coordinator.getSnapshot()).toMatchObject({
      phase: 'restorePaused',
      notice: 'NETWORK_UNAVAILABLE'
    })

    restoreHarness.http.me.mockResolvedValue({
      user: { id: '20000000-0000-4000-8000-000000000001', nickname: '모험가000001' }
    })
    const retry = await restored.coordinator.retryAuth()
    await settle()
    expect(retry).toMatchObject({ ok: true, snapshot: { phase: 'signedIn' } })
  })
})
