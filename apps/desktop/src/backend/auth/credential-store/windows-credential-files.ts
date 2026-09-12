import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path/win32'
import type { StoreMutationOutcome } from '../types'
import type { CredentialFileOperations, CredentialRecordName } from './credential-files'
import { MAX_RECORD_BYTES } from './credential-record'

export type WindowsCapability = 'confirmed' | 'unknown' | 'unavailable'

export type WindowsCredentialCapabilities = Readonly<{
  profileProtection: WindowsCapability
  fileMutation: WindowsCapability
  namespaceMutation: WindowsCapability
}>

export type WindowsPathInspection =
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'trusted-directory' }>
  | Readonly<{ status: 'trusted-file' }>
  | Readonly<{ status: 'reparse' }>
  | Readonly<{ status: 'untrusted' }>
  | Readonly<{ status: 'unavailable' }>

export type WindowsCredentialFileHandle = Readonly<{
  read(maximumBytes: number): Promise<Buffer>
  write(data: Buffer): Promise<void>
  flush(): Promise<void>
  rename(destination: string): Promise<void>
  close(): Promise<void>
}>

export type WindowsCredentialNative = Readonly<{
  capabilities: WindowsCredentialCapabilities
  inspect(path: string, kind: 'directory' | 'file'): Promise<WindowsPathInspection>
  createDirectory(path: string): Promise<'created' | 'already-exists'>
  list(path: string): Promise<string[]>
  openRead(path: string): Promise<WindowsCredentialFileHandle>
  createExclusive(path: string): Promise<WindowsCredentialFileHandle>
  remove(path: string): Promise<void>
  syncDirectory(path: string): Promise<void>
}>

const OWNED_TEMP =
  /^\.(credential|transition)\.v1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

function assertUsableCapabilities(capabilities: WindowsCredentialCapabilities): void {
  const hasProfileProtection = capabilities.profileProtection === 'confirmed'
  const hasFileMutation = capabilities.fileMutation === 'confirmed'
  const hasNamespaceMutation = capabilities.namespaceMutation === 'confirmed'
  const isUsable = hasProfileProtection && hasFileMutation && hasNamespaceMutation
  if (!isUsable) {
    throw new Error('Windows credential storage capability is unavailable.')
  }
}

function assertTrustedDirectory(inspection: WindowsPathInspection): void {
  if (inspection.status !== 'trusted-directory') {
    throw new Error('Windows credential storage protection is unavailable.')
  }
}

function assertTrustedFile(inspection: WindowsPathInspection): void {
  if (inspection.status !== 'trusted-file') {
    throw new Error('Windows credential storage protection is unavailable.')
  }
}

export class WindowsCredentialFiles implements CredentialFileOperations {
  readonly directory: string

  constructor(
    private readonly userDataPath: string,
    environment: string,
    private readonly native: WindowsCredentialNative
  ) {
    this.directory = join(userDataPath, 'auth', environment)
  }

  async prepare(): Promise<void> {
    assertUsableCapabilities(this.native.capabilities)
    for (const path of [
      this.userDataPath,
      join(this.userDataPath, 'auth'),
      this.directory
    ]) {
      const inspection = await this.native.inspect(path, 'directory')
      if (inspection.status === 'missing') {
        await this.native.createDirectory(path)
        assertTrustedDirectory(await this.native.inspect(path, 'directory'))
        await this.native.syncDirectory(path)
        await this.native.syncDirectory(dirname(path))
        continue
      }
      assertTrustedDirectory(inspection)
    }
  }

  async present(name: string): Promise<boolean> {
    const inspection = await this.native.inspect(join(this.directory, name), 'file')
    if (inspection.status === 'missing') {
      return false
    }
    assertTrustedFile(inspection)
    return true
  }

  async ownedTemporaries(): Promise<string[]> {
    const names = await this.native.list(this.directory)
    return names.filter((name) => OWNED_TEMP.test(name)).sort()
  }

  async read(name: CredentialRecordName): Promise<Buffer | null> {
    const exists = await this.present(name)
    if (!exists) {
      return null
    }
    const handle = await this.native.openRead(join(this.directory, name))
    try {
      return await handle.read(MAX_RECORD_BYTES + 1)
    } finally {
      await handle.close()
    }
  }

  async replace(name: CredentialRecordName, data: Buffer): Promise<StoreMutationOutcome> {
    let replacementAttempted = false
    let handle: WindowsCredentialFileHandle | null = null
    let outcome: StoreMutationOutcome = 'failed'
    try {
      await this.prepare()
      await this.present(name)
      const temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`)
      handle = await this.native.createExclusive(temporary)
      await handle.write(data)
      await handle.flush()
      replacementAttempted = true
      await handle.rename(join(this.directory, name))
      await handle.flush()
      await this.native.syncDirectory(this.directory)
      if (name === 'transition.v1') {
        await this.discardMarkerTemporaries()
      }
      outcome = 'confirmed'
    } catch {
      outcome = replacementAttempted ? 'unknown' : 'failed'
    }
    if (handle != null) {
      try {
        await handle.close()
      } catch {
        outcome = replacementAttempted ? 'unknown' : 'failed'
      }
    }
    return outcome
  }

  private async discardMarkerTemporaries(): Promise<void> {
    const names = (await this.ownedTemporaries()).filter((name) =>
      name.startsWith('.transition.v1.')
    )
    for (const name of names) {
      await this.native.remove(join(this.directory, name))
    }
    if (names.length > 0) {
      await this.native.syncDirectory(this.directory)
    }
  }

  async clear(): Promise<StoreMutationOutcome> {
    let deletionAttempted = false
    try {
      await this.prepare()
      const names = ['credential.v1', ...(await this.ownedTemporaries())]
      for (const name of names) {
        const exists = await this.present(name)
        if (!exists) {
          continue
        }
        deletionAttempted = true
        await this.native.remove(join(this.directory, name))
      }
      await this.native.syncDirectory(this.directory)
      return 'confirmed'
    } catch {
      return deletionAttempted ? 'unknown' : 'failed'
    }
  }

  async removeMarker(): Promise<StoreMutationOutcome> {
    try {
      await this.prepare()
      const exists = await this.present('transition.v1')
      if (!exists) {
        return 'unknown'
      }
      await this.native.remove(join(this.directory, 'transition.v1'))
      await this.native.syncDirectory(this.directory)
      return 'confirmed'
    } catch {
      return 'unknown'
    }
  }
}
