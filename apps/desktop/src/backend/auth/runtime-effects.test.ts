import { describe, expect, it, vi } from 'vitest'
import { createAuthRuntimeEffects } from './runtime-effects'
import { createAuthHarness, deferred } from './auth-test-fixtures'
import { bootstrapAuthRuntime } from './bootstrap'
import type { AuthRuntimeConfig } from './runtime-config'

const config: AuthRuntimeConfig = {
  apiOrigin: 'https://api.synthetic.test',
  returnTarget: 'ldb-synthetic://auth/return',
  environment: 'test',
  providers: ['google'],
  appIdentity: 'com.synthetic.ldb',
  userDataPath: '/synthetic/user-data'
}

describe('desktop auth runtime effects', () => {
  it('binds HTTP, browser and store to the same trusted runtime tuple', async () => {
    const harness = createAuthHarness()
    const fetch = vi.fn()
    const announceCredentialAccess = vi.fn(async () => undefined)
    const openExternal = vi.fn(async () => undefined)
    const http = vi.fn(() => harness.dependencies.http)
    const store = vi.fn(() => harness.store)
    const effects = createAuthRuntimeEffects({
      config,
      app: { getPath: () => '/synthetic/user-data' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString()
      },
      platform: 'darwin',
      fetch,
      showMessageBox: announceCredentialAccess,
      openExternal,
      createHttp: http,
      createStore: store
    })

    await effects.announceCredentialAccess()
    const dependencies = effects.createDependencies()

    expect(announceCredentialAccess).toHaveBeenCalledOnce()
    expect(http).toHaveBeenCalledWith({ apiOrigin: config.apiOrigin, fetch })
    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({
        userDataPath: '/synthetic/user-data',
        context: {
          environment: config.environment,
          apiOrigin: config.apiOrigin,
          clientId: 'desktop'
        },
        platform: 'darwin'
      })
    )
    expect(dependencies.apiOrigin).toBe(config.apiOrigin)
    await dependencies.browser.open(
      'https://api.synthetic.test/auth/login/authorize?ticket=synthetic'
    )
    expect(openExternal).toHaveBeenCalledOnce()
  })

  it('reports a runtime wall-clock reversal as discontinuous', () => {
    let wallMs = 1_000
    let monotonicMs = 50
    const harness = createAuthHarness()
    const effects = createAuthRuntimeEffects({
      config,
      app: { getPath: () => config.userDataPath },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString()
      },
      platform: 'darwin',
      readWallMs: () => wallMs,
      readMonotonicMs: () => monotonicMs,
      createHttp: () => harness.dependencies.http,
      createStore: () => harness.store
    })
    const clock = effects.createDependencies().clock

    expect(clock.read()).toEqual({ wallMs: 1_000, monotonicMs: 50, discontinuous: false })
    wallMs = 900
    monotonicMs = 40

    expect(clock.read()).toEqual({ wallMs: 900, monotonicMs: 40, discontinuous: true })
    wallMs = 910
    monotonicMs = 50

    expect(clock.read()).toEqual({ wallMs: 910, monotonicMs: 50, discontinuous: true })
  })

  it('passes a wall-clock reversal during restore to the coordinator pause guard', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'ready', refreshToken: 'synthetic-refresh-token' }
    const me = deferred<Awaited<ReturnType<typeof harness.dependencies.http.me>>>()
    harness.http.me.mockImplementation(async () => me.promise)
    let wallMs = Date.parse('2026-09-06T12:00:00.000Z')
    let monotonicMs = 1_000
    const effects = createAuthRuntimeEffects({
      config,
      app: { getPath: () => config.userDataPath },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString()
      },
      platform: 'darwin',
      readWallMs: () => wallMs,
      readMonotonicMs: () => monotonicMs,
      createHttp: () => harness.dependencies.http,
      createStore: () => harness.store
    })
    const runtime = await bootstrapAuthRuntime({
      config,
      effects: {
        announceCredentialAccess: vi.fn(async () => undefined),
        createDependencies: effects.createDependencies
      }
    })
    if (runtime == null) {
      throw new Error('Synthetic auth runtime should be available')
    }

    const start = runtime.start()
    await vi.waitFor(() => expect(harness.http.me).toHaveBeenCalledOnce())
    wallMs -= 1_000
    monotonicMs -= 1_000
    me.resolve({ user: { id: '20000000-0000-4000-8000-000000000001', nickname: '모험가000001' } })
    await start

    expect(runtime.coordinator.getSnapshot()).toMatchObject({
      phase: 'restorePaused',
      notice: 'RESTORE_RETRY_REQUIRED'
    })
  })

  it('uses the dependency creation clock reading as the restore discontinuity baseline', async () => {
    const harness = createAuthHarness()
    harness.store.inspection = { status: 'ready', refreshToken: 'synthetic-refresh-token' }
    const commit =
      deferred<Awaited<ReturnType<typeof harness.dependencies.store.commitCredential>>>()
    harness.store.commitWaits.push(commit.promise)
    let wallMs = Date.parse('2026-09-06T12:00:00.000Z')
    let monotonicMs = 1_000
    const effects = createAuthRuntimeEffects({
      config,
      app: { getPath: () => config.userDataPath },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString()
      },
      platform: 'darwin',
      readWallMs: () => wallMs,
      readMonotonicMs: () => monotonicMs,
      createHttp: () => harness.dependencies.http,
      createStore: () => harness.store
    })
    const runtime = await bootstrapAuthRuntime({
      config,
      effects: {
        announceCredentialAccess: vi.fn(async () => undefined),
        createDependencies: effects.createDependencies
      }
    })
    if (runtime == null) {
      throw new Error('Synthetic auth runtime should be available')
    }

    const start = runtime.start()
    await vi.waitFor(() => expect(harness.store.commitCredential).toHaveBeenCalledOnce())
    wallMs -= 1_000
    monotonicMs += 100
    commit.resolve('confirmed')
    await start

    expect(runtime.coordinator.getSnapshot()).toMatchObject({
      phase: 'restorePaused',
      notice: 'RESTORE_RETRY_REQUIRED'
    })
    expect(harness.http.me).not.toHaveBeenCalled()
  })
})
