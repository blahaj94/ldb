import { describe, expect, it, vi } from 'vitest'
import { clearCredential, finalizeCredentialTransition } from '../credential-operations'
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
import { WindowsCredentialFiles } from './windows-credential-files'

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
  it('selects only owned temporaries and preserves credential, marker and unrelated files during marker cleanup', async () => {
    const fixture = createWindowsFixture()
    const credentialTemp = '.credential.v1.00000000-0000-0000-0000-000000000001.tmp'
    const markerTemp = '.transition.v1.00000000-0000-0000-0000-000000000002.tmp'
    const preserved = [
      'credential.v1',
      credentialTemp,
      'notes.txt',
      '.credential.v1.not-a-uuid.tmp',
      `${markerTemp}.bak`
    ]
    for (const name of [...preserved, markerTemp]) {
      fixture.stores.set(`${DIRECTORY}\\${name}`, Buffer.from('synthetic record'))
    }
    const files = new WindowsCredentialFiles(USER_DATA_PATH, 'test', fixture.native)

    expect(await files.ownedTemporaries()).toEqual([credentialTemp, markerTemp])
    expect(await files.replace('transition.v1', Buffer.from('synthetic marker'))).toBe('confirmed')
    expect(fixture.native.remove).toHaveBeenCalledExactlyOnceWith(`${DIRECTORY}\\${markerTemp}`)
    for (const name of [...preserved, 'transition.v1']) {
      expect(fixture.stores.has(`${DIRECTORY}\\${name}`)).toBe(true)
    }
  })

  it('finishes enumeration before any deletion and leaves all files on an incomplete list', async () => {
    const fixture = createWindowsFixture()
    const temporary = '.credential.v1.00000000-0000-0000-0000-000000000001.tmp'
    for (const name of ['credential.v1', 'transition.v1', temporary]) {
      fixture.stores.set(`${DIRECTORY}\\${name}`, Buffer.from('synthetic record'))
    }
    let rejectList: (error: Error) => void = () => undefined
    vi.mocked(fixture.native.list).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectList = reject
        })
    )
    const files = new WindowsCredentialFiles(USER_DATA_PATH, 'test', fixture.native)
    const clearing = files.clear()
    await vi.waitFor(() => expect(fixture.native.list).toHaveBeenCalledOnce())
    expect(fixture.native.remove).not.toHaveBeenCalled()
    rejectList(new Error('Synthetic failure after partial native results.'))

    expect(await clearing).toBe('failed')
    expect(fixture.native.remove).not.toHaveBeenCalled()
    expect(fixture.stores.size).toBe(3)
    vi.mocked(fixture.native.list).mockRejectedValue(new Error('Synthetic enumeration failure.'))
    expect(await createStore(fixture).inspect()).toEqual({ status: 'unavailable' })
  })

  it('clears credential and owned temporaries while preserving marker and unrelated files', async () => {
    const fixture = createWindowsFixture()
    const owned = [
      'credential.v1',
      '.credential.v1.00000000-0000-0000-0000-000000000001.tmp',
      '.transition.v1.00000000-0000-0000-0000-000000000002.tmp'
    ]
    const preserved = ['transition.v1', 'notes.txt', '.transition.v1.invalid.tmp']
    for (const name of [...owned, ...preserved]) {
      fixture.stores.set(`${DIRECTORY}\\${name}`, Buffer.from('synthetic record'))
    }
    const files = new WindowsCredentialFiles(USER_DATA_PATH, 'test', fixture.native)

    expect(await files.clear()).toBe('confirmed')
    expect([...fixture.stores.keys()].sort()).toEqual(
      preserved.map((name) => `${DIRECTORY}\\${name}`).sort()
    )
  })

  it.each(['reparse', 'untrusted'] as const)(
    'refuses to delete an owned temporary with %s protection',
    async (status) => {
      const fixture = createWindowsFixture()
      const path = `${DIRECTORY}\\.credential.v1.00000000-0000-0000-0000-000000000001.tmp`
      fixture.stores.set(path, Buffer.from('synthetic record'))
      fixture.setInspection(path, { status })
      const files = new WindowsCredentialFiles(USER_DATA_PATH, 'test', fixture.native)

      expect(await files.clear()).toBe('failed')
      expect(fixture.native.remove).not.toHaveBeenCalled()
      expect(fixture.stores.has(path)).toBe(true)
    }
  )

  it('reports an owned temporary as recovery-required without decrypting a credential', async () => {
    const fixture = createWindowsFixture()
    fixture.stores.set(
      `${DIRECTORY}\\.credential.v1.00000000-0000-0000-0000-000000000001.tmp`,
      Buffer.from('synthetic')
    )

    expect(await createStore(fixture).inspect()).toEqual({ status: 'recovery-required' })
    expect(fixture.safeStorage.decryptString).not.toHaveBeenCalled()
  })
  it('rejects before safeStorage or native calls on unsupported hosts', async () => {
    const fixture = createWindowsFixture()
    const store = createStore(fixture, { platform: 'linux' })

    expect(await store.inspect()).toEqual({ status: 'unavailable' })
    expect(await store.establishTransition('exchange')).toBe('failed')
    expect(fixture.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(fixture.native.inspect).not.toHaveBeenCalled()
  })

  it.each(['write', 'initial-flush', 'post-rename-flush', 'directory-sync', 'close'] as const)(
    'preserves replacement outcome and marker after %s failure',
    async (failure) => {
      const fixture = createWindowsFixture()
      const store = createStore(fixture)
      await store.inspect()
      await store.establishTransition('refresh')
      const rename = vi.fn<WindowsCredentialFileHandle['rename']>()
      const close = vi.fn<WindowsCredentialFileHandle['close']>()
      const error = new Error('Synthetic replacement failure.')
      vi.mocked(fixture.native.createExclusive).mockImplementationOnce(async (path) => {
        const handle = createHandle(path, fixture.stores, fixture)
        rename.mockImplementation(handle.rename)
        close.mockImplementation(handle.close)
        const flush = vi.fn(handle.flush)
        if (failure === 'initial-flush') {
          flush.mockRejectedValueOnce(error)
        }
        if (failure === 'post-rename-flush') {
          flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error)
        }
        if (failure === 'close') {
          close.mockRejectedValueOnce(error)
        }
        return {
          ...handle,
          write: failure === 'write' ? vi.fn().mockRejectedValue(error) : handle.write,
          flush,
          rename,
          close
        }
      })
      if (failure === 'directory-sync') {
        vi.mocked(fixture.native.syncDirectory).mockRejectedValueOnce(error)
      }
      const isBeforeRename = failure === 'write' || failure === 'initial-flush'

      expect(await store.commitCredential(REFRESH_1)).toBe(isBeforeRename ? 'failed' : 'unknown')
      expect(rename).toHaveBeenCalledTimes(isBeforeRename ? 0 : 1)
      expect(close).toHaveBeenCalledOnce()
      expect(fixture.stores.has(`${DIRECTORY}\\credential.v1`)).toBe(!isBeforeRename)
      fixture.safeStorage.decryptString.mockClear()
      expect(await createStore(fixture).inspect()).toEqual({ status: 'recovery-required' })
      expect(fixture.safeStorage.decryptString).not.toHaveBeenCalled()
    }
  )

  it.each([true, false])(
    'distinguishes marker removal sync failure with reestablishment=%s',
    async (canReestablish) => {
      const fixture = createWindowsFixture()
      const store = createStore(fixture)
      await store.inspect()
      await store.establishTransition('refresh')
      await store.commitCredential(REFRESH_1)
      vi.mocked(fixture.native.syncDirectory).mockRejectedValueOnce(
        new Error('Synthetic marker deletion sync failure.')
      )
      if (!canReestablish) {
        vi.mocked(fixture.native.createExclusive).mockRejectedValueOnce(
          new Error('Synthetic marker reestablishment failure.')
        )
      }

      expect(await finalizeCredentialTransition(store, 'refresh')).toBe(
        canReestablish ? 'save-failed' : 'clear-unconfirmed'
      )
      expect(fixture.native.remove).toHaveBeenCalledWith(`${DIRECTORY}\\transition.v1`)
      expect(fixture.stores.has(`${DIRECTORY}\\transition.v1`)).toBe(canReestablish)
      expect(await createStore(fixture).inspect()).toEqual(
        canReestablish
          ? { status: 'recovery-required' }
          : { status: 'ready', refreshToken: REFRESH_1 }
      )
    }
  )

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
