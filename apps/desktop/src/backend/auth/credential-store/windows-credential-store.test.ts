import { describe, expect, it, vi } from 'vitest'
import { clearCredential } from '../credential-operations'
import type { CredentialStore } from '../types'
import { CONTEXT, REFRESH_0, REFRESH_1 } from './credential-store-test-fixture'
import {
  createWindowsCredentialStore,
  type WindowsCredentialStoreOptions
} from './windows-credential-store'
import type {
  WindowsCredentialFileHandle,
  WindowsCredentialNative,
  WindowsPathInspection
} from './windows-credential-files'

type WindowsFixture = {
  native: WindowsCredentialNative
  safeStorage: Readonly<{
    isEncryptionAvailable: ReturnType<typeof vi.fn<() => boolean>>
    encryptString: ReturnType<typeof vi.fn<(plaintext: string) => Buffer>>
    decryptString: ReturnType<typeof vi.fn<(ciphertext: Buffer) => string>>
  }>
  stores: Map<string, Buffer>
  directories: Set<string>
  paths: Readonly<{ userData: string; directory: string }>
  failAfterRename: boolean
  failAfterDelete: boolean
  setInspection(path: string, inspection: WindowsPathInspection): void
}

const USER_DATA_PATH = String.raw`C:\Users\Alice\LdbProfile`
const DIRECTORY = String.raw`C:\Users\Alice\LdbProfile\auth\test`

function createHandle(
  path: string,
  stores: Map<string, Buffer>,
  fixture: { failAfterRename: boolean }
): WindowsCredentialFileHandle {
  return {
    read: async (maximumBytes) => (stores.get(path) ?? Buffer.alloc(0)).subarray(0, maximumBytes),
    write: async (data) => {
      stores.set(path, Buffer.from(data))
    },
    flush: async () => undefined,
    rename: async (destination) => {
      const value = stores.get(path)
      if (value == null) {
        throw new Error('Synthetic handle rename source is missing.')
      }
      stores.set(destination, value)
      stores.delete(path)
      if (fixture.failAfterRename) {
        throw new Error('Synthetic rename result is unknown.')
      }
    },
    close: async () => undefined
  }
}

function createWindowsFixture(): WindowsFixture {
  const stores = new Map<string, Buffer>()
  const directories = new Set<string>()
  const inspections = new Map<string, WindowsPathInspection>()
  const state = { failAfterRename: false, failAfterDelete: false }
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((plaintext: string) => Buffer.from(`ciphertext:${plaintext}`)),
    decryptString: vi.fn((ciphertext: Buffer) => {
      const encoded = ciphertext.toString()
      if (!encoded.startsWith('ciphertext:')) {
        throw new Error('Synthetic ciphertext rejected.')
      }
      return encoded.slice('ciphertext:'.length)
    })
  }
  const native: WindowsCredentialNative = {
    capabilities: {
      profileProtection: 'confirmed',
      fileMutation: 'confirmed',
      namespaceMutation: 'confirmed'
    },
    inspect: vi.fn<WindowsCredentialNative['inspect']>(async (path, kind) => {
      const configured = inspections.get(path)
      if (configured != null) {
        return configured
      }
      if (kind === 'directory') {
        return directories.has(path) ? { status: 'trusted-directory' } : { status: 'missing' }
      }
      return stores.has(path) ? { status: 'trusted-file' } : { status: 'missing' }
    }),
    createDirectory: vi.fn<WindowsCredentialNative['createDirectory']>(async (path) => {
      directories.add(path)
      return 'created'
    }),
    list: vi.fn(async () =>
      [...stores.keys()]
        .filter((path) => path.startsWith(`${DIRECTORY}\\`))
        .map((path) => path.slice(`${DIRECTORY}\\`.length))
    ),
    openRead: vi.fn(async (path) => createHandle(path, stores, state)),
    createExclusive: vi.fn(async (path) => {
      if (stores.has(path)) {
        throw new Error('Synthetic exclusive creation conflict.')
      }
      stores.set(path, Buffer.alloc(0))
      return createHandle(path, stores, state)
    }),
    remove: vi.fn(async (path) => {
      stores.delete(path)
      if (state.failAfterDelete) {
        throw new Error('Synthetic delete result is unknown.')
      }
    }),
    syncDirectory: vi.fn(async () => undefined)
  }
  const paths = { userData: USER_DATA_PATH, directory: DIRECTORY }
  const fixture = {
    native,
    safeStorage,
    stores,
    directories,
    paths,
    get failAfterRename() {
      return state.failAfterRename
    },
    set failAfterRename(value: boolean) {
      state.failAfterRename = value
    },
    get failAfterDelete() {
      return state.failAfterDelete
    },
    set failAfterDelete(value: boolean) {
      state.failAfterDelete = value
    },
    setInspection(path: string, inspection: WindowsPathInspection) {
      inspections.set(path, inspection)
    }
  }
  return fixture
}

function createStore(
  fixture: WindowsFixture,
  overrides: Partial<WindowsCredentialStoreOptions> = {}
): CredentialStore {
  return createWindowsCredentialStore({
    userDataPath: fixture.paths.userData,
    context: CONTEXT,
    safeStorage: fixture.safeStorage,
    native: fixture.native,
    platform: 'win32',
    ...overrides
  })
}

describe('Windows CredentialStore native boundary', () => {
  it('rejects before safeStorage or native calls on unsupported hosts', async () => {
    const fixture = createWindowsFixture()
    const store = createStore(fixture, { platform: 'linux' })

    expect(await store.inspect()).toEqual({ status: 'unavailable' })
    expect(await store.establishTransition('exchange')).toBe('failed')
    expect(fixture.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(fixture.native.inspect).not.toHaveBeenCalled()
  })

  it('reuses common marker and credential protocol through the Windows boundary', async () => {
    const fixture = createWindowsFixture()
    const store = createStore(fixture)

    expect(await store.inspect()).toEqual({ status: 'empty' })
    expect(await store.establishTransition('exchange')).toBe('confirmed')
    expect(await store.commitCredential(REFRESH_1)).toBe('confirmed')
    expect(await store.removeTransition()).toBe('confirmed')
    expect(await createStore(fixture).inspect()).toEqual({
      status: 'ready',
      refreshToken: REFRESH_1
    })
  })

  it.each([
    ['reparse', { status: 'reparse' }],
    ['untrusted ACL', { status: 'untrusted' }]
  ] as const)('fails closed for a %s profile path', async (_kind, inspection) => {
    const fixture = createWindowsFixture()
    fixture.setInspection(fixture.paths.userData, inspection)

    expect(await createStore(fixture).inspect()).toEqual({ status: 'unavailable' })
    expect(fixture.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
  })

  it('does not expose an unverified namespace durability capability as available', async () => {
    const fixture = createWindowsFixture()
    const native: WindowsCredentialNative = {
      ...fixture.native,
      capabilities: { ...fixture.native.capabilities, namespaceMutation: 'unknown' }
    }

    expect(await createStore(fixture, { native }).inspect()).toEqual({ status: 'unavailable' })
    expect(fixture.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
  })

  it('reports an applied rename result as unknown and preserves recovery blocking', async () => {
    const fixture = createWindowsFixture()
    const store = createStore(fixture)
    await store.inspect()
    await store.establishTransition('refresh')
    fixture.failAfterRename = true

    expect(await store.commitCredential(REFRESH_1)).toBe('unknown')
    expect(await createStore(fixture).inspect()).toEqual({ status: 'recovery-required' })
  })

  it('does not report deletion as clean after an uncertain native result', async () => {
    const fixture = createWindowsFixture()
    const store = createStore(fixture)
    await store.inspect()
    await store.establishTransition('exchange')
    await store.commitCredential(REFRESH_0)
    await store.removeTransition()
    fixture.failAfterDelete = true

    expect(await clearCredential(store)).toBe('unconfirmed')
    expect(await createStore(fixture).inspect()).toEqual({ status: 'recovery-required' })
  })
})
