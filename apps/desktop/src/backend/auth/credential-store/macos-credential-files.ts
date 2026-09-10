import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { StoreMutationOutcome } from '../types'
import { MAX_RECORD_BYTES } from './credential-record'

export type CredentialFiles = Pick<
  typeof fs,
  'open' | 'mkdir' | 'lstat' | 'readdir' | 'rename' | 'unlink'
>
type RecordName = 'credential.v1' | 'transition.v1'
const OWNED_TEMP =
  /^\.(credential|transition)\.v1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/

function isMissing(error: unknown): boolean {
  const hasError = error != null
  if (!hasError) {
    return false
  }

  const isErrorObject = typeof error === 'object'
  if (!isErrorObject) {
    return false
  }

  const hasCode = 'code' in error
  if (!hasCode) {
    return false
  }

  const isNotFound = error.code === 'ENOENT'
  return isNotFound
}

type AssertPrivateInput = Readonly<{
  stat: Stats
  directory: boolean
}>

function assertPrivate({ stat, directory }: AssertPrivateInput): void {
  const isExpectedType = directory ? stat.isDirectory() : stat.isFile()
  const hasExpectedOwner = stat.uid === process.getuid?.()
  const expectedMode = directory ? 0o700 : 0o600
  const hasPrivateMode = (stat.mode & 0o7777) === expectedMode
  const isPrivate = isExpectedType && hasExpectedOwner && hasPrivateMode
  if (!isPrivate) {
    throw new Error('Credential storage protection is unavailable.')
  }
}

export class MacOsCredentialFiles {
  readonly directory: string

  constructor(
    private readonly userDataPath: string,
    environment: string,
    private readonly files: CredentialFiles = fs
  ) {
    this.directory = join(userDataPath, 'auth', environment)
  }

  async prepare(): Promise<void> {
    for (const path of [this.userDataPath, join(this.userDataPath, 'auth'), this.directory]) {
      let created = false
      try {
        assertPrivate({ stat: await this.files.lstat(path), directory: true })
      } catch (error) {
        const wasMissing = isMissing(error)
        if (!wasMissing) {
          throw error
        }
        await this.files.mkdir(path, { mode: 0o700 })
        created = true
      }
      if (created) {
        await this.syncDirectory({ path })
        // 새 directory 자체와 그 이름을 담은 parent entry를 모두 flush한다.
        await this.syncDirectory({ path: dirname(path), requirePrivate: false })
      }
    }
  }

  async present(name: string): Promise<boolean> {
    try {
      assertPrivate({ stat: await this.files.lstat(join(this.directory, name)), directory: false })
      return true
    } catch (error) {
      const wasMissing = isMissing(error)
      if (wasMissing) {
        return false
      }
      throw error
    }
  }

  async ownedTemporaries(): Promise<string[]> {
    const names = await this.files.readdir(this.directory)
    return names
      .filter((name) => {
        const isOwnedTemporary = OWNED_TEMP.test(name)
        return isOwnedTemporary
      })
      .sort()
  }

  async read(name: RecordName): Promise<Buffer | null> {
    const exists = await this.present(name)
    if (!exists) {
      return null
    }
    const handle = await this.files.open(
      join(this.directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW
    )
    try {
      assertPrivate({ stat: await handle.stat(), directory: false })
      const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
      let offset = 0
      while (true) {
        const hasCapacity = offset < buffer.length
        if (!hasCapacity) {
          break
        }
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        const reachedEnd = bytesRead === 0
        if (reachedEnd) {
          break
        }
        offset += bytesRead
      }
      return buffer.subarray(0, offset)
    } finally {
      await handle.close()
    }
  }

  async replace(name: RecordName, data: Buffer): Promise<StoreMutationOutcome> {
    let replacementAttempted = false
    try {
      await this.prepare()
      await this.present(name)
      const temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`)
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
      const handle = await this.files.open(temporary, flags, 0o600)
      try {
        assertPrivate({ stat: await handle.stat(), directory: false })
        await handle.writeFile(data)
        await handle.sync()
      } finally {
        await handle.close()
      }
      replacementAttempted = true
      await this.files.rename(temporary, join(this.directory, name))
      await this.syncDirectory()
      const isMarker = name === 'transition.v1'
      if (isMarker) {
        await this.discardMarkerTemporaries()
      }
      return 'confirmed'
    } catch {
      // rename 호출 이후 오류는 destination이 실제 교체됐는지 추측하지 않는다.
      return replacementAttempted ? 'unknown' : 'failed'
    }
  }

  private async discardMarkerTemporaries(): Promise<void> {
    const names = (await this.ownedTemporaries()).filter((name) => {
      const isMarkerTemporary = name.startsWith('.transition.v1.')
      return isMarkerTemporary
    })
    const hasTemporaries = names.length > 0
    if (!hasTemporaries) {
      return
    }
    // 새 marker의 directory sync 이후에만 이전 시도의 temp를 지운다.
    for (const name of names) {
      await this.present(name)
    }
    for (const name of names) {
      await this.files.unlink(join(this.directory, name))
    }
    await this.syncDirectory()
  }

  async clear(): Promise<StoreMutationOutcome> {
    let deletionAttempted = false
    try {
      await this.prepare()
      const names = ['credential.v1', ...(await this.ownedTemporaries())]
      const present: string[] = []
      for (const name of names) {
        const exists = await this.present(name)
        if (exists) {
          present.push(name)
        }
      }
      for (const name of present) {
        deletionAttempted = true
        await this.files.unlink(join(this.directory, name))
      }
      deletionAttempted = true
      await this.syncDirectory()
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
      await this.files.unlink(join(this.directory, 'transition.v1'))
      await this.syncDirectory()
      return 'confirmed'
    } catch {
      // unlink 전 실패도 안전하게 재확립한다. 삭제 뒤 flush 실패는 특히 marker 보존 증거가 아니다.
      return 'unknown'
    }
  }

  private async syncDirectory({
    path = this.directory,
    requirePrivate = true
  }: Readonly<{ path?: string; requirePrivate?: boolean }> = {}): Promise<void> {
    const handle = await this.files.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    )
    try {
      if (requirePrivate) {
        assertPrivate({ stat: await handle.stat(), directory: true })
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}
