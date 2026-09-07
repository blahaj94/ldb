import * as fs from 'node:fs/promises'
import type { Mode, PathLike } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import type { MockedFunction } from 'vitest'
import type { CredentialStore } from '../types'
import { createMacOsCredentialStore } from './macos-credential-store'

export const CONTEXT = {
  environment: 'test',
  apiOrigin: 'https://credential.example.test',
  clientId: 'desktop'
} as const
export const REFRESH_0 = Buffer.alloc(32, 31).toString('base64url')
export const REFRESH_1 = Buffer.alloc(32, 32).toString('base64url')

type OpenObservation = Readonly<{
  path: string
  flags: string | number | undefined
  mode: Mode | undefined
}>
export type StoreFixture = Readonly<{
  userDataPath: string
  directory: string
  events: string[]
  opens: OpenObservation[]
  failures: Map<string, Array<'before' | 'after'>>
  waits: Map<string, Promise<void>[]>
  openHandles: Set<fs.FileHandle>
  safeStorage: Readonly<{
    isEncryptionAvailable: MockedFunction<() => boolean>
    encryptString: MockedFunction<(plaintext: string) => Buffer>
    decryptString: MockedFunction<(ciphertext: Buffer) => string>
  }>
  plaintexts: Map<string, string>
  files: typeof fs
  store: CredentialStore
  createStore: () => CredentialStore
  seedReady: (refreshToken?: string) => Promise<void>
  writeRecord: (record: unknown) => Promise<void>
  readRecord: () => Promise<Record<string, unknown>>
  cleanup: () => Promise<void>
}>

export function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

// 실제 임시 file IO를 유지하고 지정한 호출의 실패·지연만 주입한다.
export async function createStoreFixture(): Promise<StoreFixture> {
  const userDataPath = await fs.mkdtemp(join(tmpdir(), 'ldb-credential-127-'))
  const directory = join(userDataPath, 'auth', CONTEXT.environment)
  const events: string[] = []
  const opens: OpenObservation[] = []
  const failures = new Map<string, Array<'before' | 'after'>>()
  const waits = new Map<string, Promise<void>[]>()
  const openHandles = new Set<fs.FileHandle>()
  const plaintexts = new Map<string, string>()
  let ciphertextSequence = 0

  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((plaintext: string) => {
      const ciphertext = Buffer.from(`synthetic-ciphertext-${++ciphertextSequence}`)
      plaintexts.set(ciphertext.toString('base64'), plaintext)
      return ciphertext
    }),
    decryptString: vi.fn((ciphertext: Buffer) => {
      const plaintext = plaintexts.get(ciphertext.toString('base64'))
      const isUnknownCiphertext = plaintext == null
      if (isUnknownCiphertext) {
        throw new Error('Synthetic decryption rejected.')
      }
      return plaintext
    })
  }

  function label(path: PathLike): string {
    const name = basename(String(path))
    const isDirectory = String(path) === directory
    const isCredentialTemp = name.startsWith('.credential.v1.') && name.endsWith('.tmp')
    const isMarkerTemp = name.startsWith('.transition.v1.') && name.endsWith('.tmp')
    if (isDirectory) return 'directory'
    if (isCredentialTemp) return 'credential-temp'
    if (isMarkerTemp) return 'transition-temp'
    return name
  }

  async function observe<T>(event: string, operation: () => Promise<T>): Promise<T> {
    events.push(event)
    await waits.get(event)?.shift()
    const failure = failures.get(event)?.shift()
    const shouldFailBefore = failure === 'before'
    if (shouldFailBefore) {
      throw Object.assign(new Error('Synthetic file operation rejected.'), { code: 'EIO' })
    }
    const result = await operation()
    const shouldFailAfter = failure === 'after'
    if (shouldFailAfter) {
      throw Object.assign(new Error('Synthetic file result lost.'), { code: 'EIO' })
    }
    return result
  }

  const files: typeof fs = {
    ...fs,
    open: async (path, flags, mode) => {
      const kind = label(path)
      opens.push({ path: String(path), flags, mode })
      const handle = await observe(`open:${kind}`, () => fs.open(path, flags, mode))
      openHandles.add(handle)
      const sync = handle.sync.bind(handle)
      const close = handle.close.bind(handle)
      const writeFile = handle.writeFile.bind(handle)
      handle.sync = () => observe(`sync:${kind}`, sync)
      handle.writeFile = (data, options) => observe(`write:${kind}`, () => writeFile(data, options))
      handle.close = async () => {
        await close()
        openHandles.delete(handle)
      }
      return handle
    },
    rename: (from, to) => observe(`rename:${label(to)}`, () => fs.rename(from, to)),
    unlink: (path) => observe(`unlink:${label(path)}`, () => fs.unlink(path))
  }

  const createStore = (): CredentialStore =>
    createMacOsCredentialStore({
      userDataPath,
      context: CONTEXT,
      safeStorage,
      files,
      platform: 'darwin'
    })
  const store = createStore()

  async function seedReady(refreshToken = REFRESH_0): Promise<void> {
    await store.inspect()
    await store.establishTransition('exchange')
    await store.commitCredential(refreshToken)
    await store.removeTransition()
    events.length = 0
    safeStorage.encryptString.mockClear()
    safeStorage.decryptString.mockClear()
  }

  async function writeRecord(record: unknown): Promise<void> {
    await fs.writeFile(join(directory, 'credential.v1'), JSON.stringify(record), { mode: 0o600 })
  }

  async function readRecord(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(join(directory, 'credential.v1'), 'utf8'))
  }

  async function cleanup(): Promise<void> {
    const leakedHandles = [...openHandles]
    await Promise.all(leakedHandles.map((handle) => handle.close()))
    await fs.rm(userDataPath, { recursive: true, force: true })
  }

  return {
    userDataPath,
    directory,
    events,
    opens,
    failures,
    waits,
    openHandles,
    safeStorage,
    plaintexts,
    files,
    store,
    createStore,
    seedReady,
    writeRecord,
    readRecord,
    cleanup
  }
}
