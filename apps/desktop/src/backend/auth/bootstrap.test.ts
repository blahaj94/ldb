import { describe, expect, it, vi } from 'vitest'
import { bootstrapAuthRuntime } from './bootstrap'
import { createAuthHarness, CODE, deferred, REFRESH_0, settle } from './auth-test-fixtures'
import { AuthHttpFailure } from './http'
import type { AuthRuntimeConfig } from './runtime-config'
import type { AuthClock } from './types'

const config: AuthRuntimeConfig = {
  apiOrigin: 'https://api.example.test',
  returnTarget: 'ldb-test://auth/return',
  environment: 'test',
  providers: ['google', 'discord'],
  appIdentity: 'com.synthetic.ldb',
  userDataPath: '/synthetic/user-data'
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
    const searchClock = {
      read: vi.fn(() => ({ wallMs: 1, monotonicMs: 1, discontinuous: false })),
      schedule: vi.fn(() => () => undefined)
    } satisfies AuthClock
    const createSearchClock = vi.fn(() => searchClock)
    const runtime = await bootstrapAuthRuntime({
      config,
      effects: { announceCredentialAccess, createDependencies, createSearchClock }
    })

    expect(runtime?.coordinator.getSnapshot().phase).toBe('restoring')
    expect(operations).toEqual(['notice:complete', 'dependencies:create'])
    expect(announceCredentialAccess).toHaveBeenCalledOnce()
    expect(createDependencies).toHaveBeenCalledOnce()
    expect(createSearchClock).toHaveBeenCalledOnce()
    expect(runtime?.searchClock).toBe(searchClock)
    expect(runtime?.searchClock).not.toBe(harness.dependencies.clock)

    await runtime?.start()
    expect(operations).toEqual(['notice:complete', 'dependencies:create', 'store:inspect'])
  })

  it('does not create auth effects when trusted configuration is absent', async () => {
    const announceCredentialAccess = vi.fn(async () => undefined)
    const createDependencies = vi.fn(() => createAuthHarness().dependencies)
    const createSearchClock = vi.fn(() => createAuthHarness().clock)

    const runtime = await bootstrapAuthRuntime({
      config: null,
      effects: { announceCredentialAccess, createDependencies, createSearchClock }
    })

    expect(runtime).toBeNull()
    expect(announceCredentialAccess).not.toHaveBeenCalled()
    expect(createDependencies).not.toHaveBeenCalled()
    expect(createSearchClock).not.toHaveBeenCalled()
  })

  it('does not announce or create auth effects when the runtime is already inactive', async () => {
    const announceCredentialAccess = vi.fn(async () => undefined)
    const createDependencies = vi.fn(() => createAuthHarness().dependencies)
    const createSearchClock = vi.fn(() => createAuthHarness().clock)
    const isActive = vi.fn(() => false)

    const runtime = await bootstrapAuthRuntime({
      config,
      effects: { announceCredentialAccess, createDependencies, createSearchClock },
      isActive
    })

    expect(runtime).toBeNull()
    expect(isActive).toHaveBeenCalledOnce()
    expect(announceCredentialAccess).not.toHaveBeenCalled()
    expect(createDependencies).not.toHaveBeenCalled()
    expect(createSearchClock).not.toHaveBeenCalled()
  })

  it('does not inspect the store when the access notice cannot complete', async () => {
    const harness = createAuthHarness()
    const announceCredentialAccess = vi.fn(async () => {
      throw new Error('synthetic notice failure')
    })
    const createDependencies = vi.fn(() => harness.dependencies)
    const createSearchClock = vi.fn(() => harness.clock)

    const runtime = await bootstrapAuthRuntime({
      config,
      effects: { announceCredentialAccess, createDependencies, createSearchClock }
    })

    expect(runtime).toBeNull()
    expect(createDependencies).not.toHaveBeenCalled()
    expect(createSearchClock).not.toHaveBeenCalled()
    expect(harness.store.inspect).not.toHaveBeenCalled()
  })

  it('does not create auth effects when the runtime becomes inactive during the access notice', async () => {
    const harness = createAuthHarness()
    const pendingNotice = deferred<void>()
    let active = true
    const announceCredentialAccess = vi.fn(async () => pendingNotice.promise)
    const createDependencies = vi.fn(() => harness.dependencies)
    const createSearchClock = vi.fn(() => harness.clock)
    const isActive = vi.fn(() => active)

    const bootstrap = bootstrapAuthRuntime({
      config,
      effects: { announceCredentialAccess, createDependencies, createSearchClock },
      isActive
    })
    await vi.waitFor(() => expect(announceCredentialAccess).toHaveBeenCalledOnce())

    active = false
    pendingNotice.resolve()

    await expect(bootstrap).resolves.toBeNull()
    expect(isActive).toHaveBeenCalledTimes(2)
    expect(createDependencies).not.toHaveBeenCalled()
    expect(createSearchClock).not.toHaveBeenCalled()
    expect(harness.store.inspect).not.toHaveBeenCalled()
  })

  it('propagates unexpected dependency construction failures', async () => {
    const dependencyFailure = new Error('synthetic dependency construction failure')
    const createDependencies = vi.fn(() => {
      throw dependencyFailure
    })
    const createSearchClock = vi.fn(() => createAuthHarness().clock)

    const bootstrap = bootstrapAuthRuntime({
      config,
      effects: {
        announceCredentialAccess: vi.fn(async () => undefined),
        createDependencies,
        createSearchClock
      }
    })

    await expect(bootstrap).rejects.toBe(dependencyFailure)
    expect(createDependencies).toHaveBeenCalledOnce()
    expect(createSearchClock).not.toHaveBeenCalled()
  })

  it('propagates unexpected search clock construction failures', async () => {
    const harness = createAuthHarness()
    const searchClockFailure = new Error('synthetic search clock construction failure')
    const createSearchClock = vi.fn(() => {
      throw searchClockFailure
    })

    const bootstrap = bootstrapAuthRuntime({
      config,
      effects: {
        announceCredentialAccess: vi.fn(async () => undefined),
        createDependencies: vi.fn(() => harness.dependencies),
        createSearchClock
      }
    })

    await expect(bootstrap).rejects.toBe(searchClockFailure)
    expect(createSearchClock).toHaveBeenCalledOnce()
    expect(harness.entropy.uuid).not.toHaveBeenCalled()
  })

  it('propagates unexpected coordinator construction failures', async () => {
    const harness = createAuthHarness()
    const invalidDependencies = { ...harness.dependencies, apiOrigin: 'http://api.example.test' }

    const bootstrap = bootstrapAuthRuntime({
      config,
      effects: {
        announceCredentialAccess: vi.fn(async () => undefined),
        createDependencies: vi.fn(() => invalidDependencies),
        createSearchClock: vi.fn(() => harness.clock)
      }
    })

    await expect(bootstrap).rejects.toThrow('Authentication URL is invalid.')
  })

  it('connects a synthetic successful login without using production environment values', async () => {
    const harness = createAuthHarness()
    const runtime = await bootstrapAuthRuntime({
      config,
      effects: {
        announceCredentialAccess: vi.fn(async () => undefined),
        createDependencies: () => harness.dependencies,
        createSearchClock: () => harness.clock
      }
    })
    if (runtime == null) {
      throw new Error('Synthetic auth runtime should be available')
    }

    await runtime.start()
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
        createDependencies: () => failedLoginHarness.dependencies,
        createSearchClock: () => failedLoginHarness.clock
      }
    })
    if (failedLogin == null) {
      throw new Error('Synthetic auth runtime should be available')
    }
    await failedLogin.start()
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
        createDependencies: () => restoreHarness.dependencies,
        createSearchClock: () => restoreHarness.clock
      }
    })
    if (restored == null) {
      throw new Error('Synthetic auth runtime should be available')
    }
    const start = restored.start()
    await start
    expect(restored.coordinator.getSnapshot()).toMatchObject({
      phase: 'restorePaused',
      notice: 'NETWORK_UNAVAILABLE'
    })

    restoreHarness.http.me.mockResolvedValue({
      user: { id: '20000000-0000-4000-8000-000000000001', nickname: '모험가000001' }
    })
    const retry = await restored.coordinator.retryAuth()
    await settle()
    await start
    expect(retry).toMatchObject({ ok: true, snapshot: { phase: 'signedIn' } })
  })

  it('exposes restoring coordinator state before start so logout can be wired immediately', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
    const pendingMe = deferred<Awaited<ReturnType<typeof harness.dependencies.http.me>>>()
    harness.http.me.mockImplementation(async () => pendingMe.promise)
    const runtime = await bootstrapAuthRuntime({
      config,
      effects: {
        announceCredentialAccess: vi.fn(async () => undefined),
        createDependencies: () => harness.dependencies,
        createSearchClock: () => harness.clock
      }
    })
    if (runtime == null) {
      throw new Error('Synthetic auth runtime should be available')
    }

    expect(runtime.coordinator.getSnapshot().phase).toBe('restoring')
    const start = runtime.start()
    await vi.waitFor(() => expect(harness.http.me).toHaveBeenCalledOnce())
    const logout = runtime.coordinator.logout()

    expect(runtime.coordinator.getSnapshot().phase).toBe('signingOut')
    pendingMe.resolve({
      user: { id: '20000000-0000-4000-8000-000000000001', nickname: '모험가000001' }
    })
    expect(await logout).toMatchObject({ ok: true, snapshot: { phase: 'signedOut' } })
    expect(runtime.coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut' })
    await start
  })
})
