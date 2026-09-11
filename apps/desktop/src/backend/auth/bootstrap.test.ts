import { describe, expect, it, vi } from 'vitest'
import { bootstrapAuthRuntime } from './bootstrap'
import { createAuthHarness } from './auth-test-fixtures'
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
    const operations: string[] = []
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
})
