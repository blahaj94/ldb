import { describe, expect, it, vi } from 'vitest'
import { createAuthRuntimeEffects } from './runtime-effects'
import { createAuthHarness } from './auth-test-fixtures'
import type { AuthRuntimeConfig } from './runtime-config'

const config: AuthRuntimeConfig = {
  apiOrigin: 'https://api.synthetic.test',
  returnTarget: 'ldb-synthetic://auth/return',
  environment: 'test',
  providers: ['google']
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
})
