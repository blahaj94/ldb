import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearCredential,
  finalizeCredentialTransition,
  prepareCredentialTransition
} from '../credential-operations'
import { CONTEXT, REFRESH_0, REFRESH_1, createStoreFixture } from './credential-store-test-fixture'
import type { StoreFixture } from './credential-store-test-fixture'
import { createMacOsCredentialStore } from './macos-credential-store'

describe('macOS CredentialStore의 파일 protocol', () => {
  let fixture: StoreFixture

  beforeEach(async () => {
    fixture = await createStoreFixture()
  })

  afterEach(async () => {
    const leakedHandles = fixture.openHandles.size
    await fixture.cleanup()
    expect(leakedHandles).toBe(0)
    await expect(fs.lstat(fixture.userDataPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('비-macOS host는 암호화·파일 작업 전에 거절한다', async () => {
    const store = createMacOsCredentialStore({
      userDataPath: fixture.userDataPath,
      context: CONTEXT,
      safeStorage: fixture.safeStorage,
      files: fixture.files,
      platform: 'linux'
    })

    expect(await store.inspect()).toEqual({ status: 'unavailable' })
    expect(await store.establishTransition('exchange')).toBe('failed')
    expect(await store.commitCredential(REFRESH_1)).toBe('failed')
    expect(await store.clearCredential()).toBe('failed')
    expect(await store.removeTransition()).toBe('failed')
    expect(await store.reestablishTransition('clear')).toBe('failed')
    expect(fixture.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(fixture.safeStorage.encryptString).not.toHaveBeenCalled()
    expect(fixture.safeStorage.decryptString).not.toHaveBeenCalled()
    expect(await fs.readdir(fixture.userDataPath)).toEqual([])
    expect(fixture.events).toEqual([])
  })

  it('빈 저장소는 private directory를 만들고 empty로 검사한다', async () => {
    expect(await fixture.store.inspect()).toEqual({ status: 'empty' })
    const stat = await fs.lstat(fixture.directory)
    expect(stat.mode & 0o777).toBe(0o700)
    expect(stat.uid).toBe(process.getuid?.())
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })

  it('교체 후에는 exact context와 canonical R1 하나만 암호화하고 복원한다', async () => {
    await fixture.seedReady()
    expect(await fixture.store.establishTransition('refresh')).toBe('confirmed')
    expect(await fixture.store.commitCredential(REFRESH_1)).toBe('confirmed')
    expect(await fixture.store.removeTransition()).toBe('confirmed')

    const payload = JSON.parse(fixture.safeStorage.encryptString.mock.calls[0][0])
    expect(payload).toEqual({ version: 1, ...CONTEXT, refreshToken: REFRESH_1 })
    const record = await fixture.readRecord()
    expect(record).toEqual({ version: 1, ...CONTEXT, ciphertext: expect.any(String) })
    const disk = JSON.stringify(record)
    expect(disk).not.toContain(REFRESH_0)
    expect(disk).not.toContain(REFRESH_1)
    expect(await fs.readdir(fixture.directory)).toEqual(['credential.v1'])
    expect((await fs.lstat(join(fixture.directory, 'credential.v1'))).mode & 0o777).toBe(0o600)
    expect(await fixture.createStore().inspect()).toEqual({
      status: 'ready',
      refreshToken: REFRESH_1
    })
  })

  it('marker와 credential은 동일 directory exclusive temp·flush·replace·directory sync 순서다', async () => {
    await fixture.store.inspect()
    fixture.events.length = 0
    await fixture.store.establishTransition('exchange')
    await fixture.store.commitCredential(REFRESH_1)
    await fixture.store.removeTransition()

    const mutations = fixture.events.filter((event) => {
      const isWrite = event.startsWith('write:')
      const isSync = event.startsWith('sync:')
      const isRename = event.startsWith('rename:')
      const isUnlink = event.startsWith('unlink:')
      return isWrite || isSync || isRename || isUnlink
    })
    expect(mutations).toEqual([
      'write:transition-temp',
      'sync:transition-temp',
      'rename:transition.v1',
      'sync:directory',
      'write:credential-temp',
      'sync:credential-temp',
      'rename:credential.v1',
      'sync:directory',
      'unlink:transition.v1',
      'sync:directory'
    ])
    const temporaryOpens = fixture.opens.filter((entry) => entry.path.endsWith('.tmp'))
    expect(temporaryOpens).toHaveLength(2)
    for (const entry of temporaryOpens) {
      expect(entry.path.startsWith(`${fixture.directory}/`)).toBe(true)
      expect(entry.mode).toBe(0o600)
      expect(Number(entry.flags) & constants.O_EXCL).toBe(constants.O_EXCL)
      expect(Number(entry.flags) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    }
  })

  it('marker는 secret 없는 local operation만 담고 재시작에서는 복호화하지 않는다', async () => {
    await fixture.seedReady()
    await fixture.store.establishTransition('refresh')
    const marker = JSON.parse(await fs.readFile(join(fixture.directory, 'transition.v1'), 'utf8'))

    expect(marker).toEqual({ version: 1, operationId: expect.any(String), kind: 'refresh' })
    expect(await fixture.createStore().inspect()).toEqual({ status: 'recovery-required' })
    expect(fixture.safeStorage.decryptString).not.toHaveBeenCalled()
    expect(await clearCredential(fixture.createStore())).toBe('cleared')
    expect(await fixture.createStore().inspect()).toEqual({ status: 'empty' })
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })

  it('local clear는 marker 확립 후 credential과 소유 temp만 제거하고 marker를 마지막에 지운다', async () => {
    await fixture.seedReady()
    const ownedTemp = '.credential.v1.00000000-0000-4000-8000-000000000001.tmp'
    await fs.writeFile(join(fixture.directory, ownedTemp), 'synthetic-incomplete', { mode: 0o600 })
    await fs.writeFile(join(fixture.directory, 'unrelated.txt'), 'unrelated', { mode: 0o600 })

    expect(await clearCredential(fixture.store)).toBe('cleared')
    expect(await fs.readdir(fixture.directory)).toEqual(['unrelated.txt'])
    const credentialDeletion = fixture.events.indexOf('unlink:credential.v1')
    const tempDeletion = fixture.events.indexOf('unlink:credential-temp')
    const markerDeletion = fixture.events.indexOf('unlink:transition.v1')
    expect(credentialDeletion).toBeGreaterThan(fixture.events.indexOf('rename:transition.v1'))
    expect(tempDeletion).toBeGreaterThan(credentialDeletion)
    expect(markerDeletion).toBeGreaterThan(tempDeletion)
    expect(fixture.events.slice(markerDeletion + 1)).toContain('sync:directory')
  })

  it.each([
    ['version', 2],
    ['environment', 'prod'],
    ['apiOrigin', 'https://other.example.test'],
    ['clientId', 'web'],
    ['ciphertext', 42],
    ['extra', true]
  ])('outer record의 %s 오류는 복호화하지 않고 복구를 요구한다', async (key, value) => {
    await fixture.seedReady()
    await fixture.writeRecord({ ...(await fixture.readRecord()), [key]: value })

    expect(await fixture.createStore().inspect()).toEqual({ status: 'recovery-required' })
    expect(fixture.safeStorage.decryptString).not.toHaveBeenCalled()
  })

  it.each([
    { version: 2 },
    { environment: 'prod' },
    { apiOrigin: 'https://other.example.test' },
    { clientId: 'web' },
    { refreshToken: 'invalid' },
    { refreshToken: `${REFRESH_1}=` },
    { accessToken: 'forbidden.payload.signature' }
  ])('복호화된 payload도 exact context·field·canonical token을 검사한다: %j', async (changes) => {
    await fixture.seedReady()
    const record = await fixture.readRecord()
    fixture.plaintexts.set(
      String(record.ciphertext),
      JSON.stringify({
        version: 1,
        ...CONTEXT,
        refreshToken: REFRESH_1,
        ...changes
      })
    )

    expect(await fixture.createStore().inspect()).toEqual({ status: 'recovery-required' })
  })

  it.each([
    ['malformed', '{'],
    ['oversized', 'x'.repeat(16_385)]
  ])('%s record는 복구만 요구한다', async (_kind, raw) => {
    await fixture.seedReady()
    await fs.writeFile(join(fixture.directory, 'credential.v1'), raw)

    expect(await fixture.createStore().inspect()).toEqual({ status: 'recovery-required' })
    expect(fixture.safeStorage.decryptString).not.toHaveBeenCalled()
  })

  it.each(['directory', 'file', 'symlink', 'unexpected-type'] as const)(
    '%s 보호 오류는 ready로 복원하거나 대상 file을 따라가지 않는다',
    async (kind) => {
      await fixture.seedReady()
      const credentialPath = join(fixture.directory, 'credential.v1')
      const isDirectory = kind === 'directory'
      const isFile = kind === 'file'
      const isSymlink = kind === 'symlink'
      if (isDirectory) {
        await fs.chmod(fixture.directory, 0o755)
      } else if (isFile) {
        await fs.chmod(credentialPath, 0o644)
      } else {
        await fs.unlink(credentialPath)
        if (isSymlink) {
          const target = join(fixture.userDataPath, 'unrelated')
          await fs.writeFile(target, 'unrelated', { mode: 0o600 })
          await fs.symlink(target, credentialPath)
        } else {
          await fs.mkdir(credentialPath, { mode: 0o700 })
        }
      }

      expect(await fixture.createStore().inspect()).toEqual({ status: 'unavailable' })
      expect(fixture.safeStorage.decryptString).not.toHaveBeenCalled()
    }
  )

  it('backend 거절은 정상 record를 손상으로 지우지 않고 재접근 때 복원한다', async () => {
    await fixture.seedReady()
    fixture.safeStorage.decryptString.mockImplementationOnce(() => {
      throw new Error('Synthetic keychain denial.')
    })

    expect(await fixture.createStore().inspect()).toEqual({ status: 'unavailable' })
    expect(await fs.readdir(fixture.directory)).toEqual(['credential.v1'])
    expect(await fixture.createStore().inspect()).toEqual({
      status: 'ready',
      refreshToken: REFRESH_0
    })
  })

  it('암호화 불가 또는 암호화 실패는 평문 대체 저장을 만들지 않는다', async () => {
    fixture.safeStorage.isEncryptionAvailable.mockReturnValue(false)
    expect(await fixture.store.inspect()).toEqual({ status: 'unavailable' })
    fixture.safeStorage.isEncryptionAvailable.mockReturnValue(true)
    await fixture.store.inspect()
    await fixture.store.establishTransition('exchange')
    fixture.safeStorage.encryptString.mockImplementationOnce(() => {
      throw new Error('Synthetic encryption denial.')
    })

    expect(await fixture.store.commitCredential(REFRESH_1)).toBe('failed')
    expect(await fixture.createStore().inspect()).toEqual({ status: 'recovery-required' })
    expect(await fs.readdir(fixture.directory)).toEqual(['transition.v1'])
  })

  it.each([
    'open:transition-temp',
    'write:transition-temp',
    'sync:transition-temp',
    'rename:transition.v1',
    'sync:directory'
  ])('marker의 %s 실패를 confirmed로 반환하지 않는다', async (event) => {
    await fixture.seedReady()
    fixture.failures.set(event, ['before'])

    expect(await fixture.store.establishTransition('refresh')).not.toBe('confirmed')
    expect(await fs.readFile(join(fixture.directory, 'credential.v1'), 'utf8')).not.toContain(
      REFRESH_0
    )
  })

  it.each([
    'open:credential-temp',
    'write:credential-temp',
    'sync:credential-temp',
    'rename:credential.v1',
    'sync:directory'
  ])('credential의 %s 실패 뒤 marker가 R0/R1 복원을 막는다', async (event) => {
    await fixture.seedReady()
    await fixture.store.establishTransition('refresh')
    fixture.failures.set(event, ['before'])

    expect(await fixture.store.commitCredential(REFRESH_1)).not.toBe('confirmed')
    expect(await fixture.createStore().inspect()).toEqual({ status: 'recovery-required' })
    expect(fixture.safeStorage.decryptString).not.toHaveBeenCalled()
  })

  it('replace 적용 뒤 결과 유실은 unknown이며 이전 값을 복원하지 않는다', async () => {
    await fixture.seedReady()
    await fixture.store.establishTransition('refresh')
    fixture.failures.set('rename:credential.v1', ['after'])

    expect(await fixture.store.commitCredential(REFRESH_1)).toBe('unknown')
    expect(await fixture.createStore().inspect()).toEqual({ status: 'recovery-required' })
    const record = await fixture.readRecord()
    expect(JSON.parse(String(fixture.plaintexts.get(String(record.ciphertext))))).toMatchObject({
      refreshToken: REFRESH_1
    })
  })

  it('marker rename 적용 전 실패를 재확립한 뒤 완전히 저장한 R1은 재시작에도 ready다', async () => {
    await fixture.seedReady()
    fixture.failures.set('rename:transition.v1', ['before'])

    expect(await prepareCredentialTransition(fixture.store, 'refresh')).toBe('established')
    expect(await fixture.store.commitCredential(REFRESH_1)).toBe('confirmed')
    expect(await finalizeCredentialTransition(fixture.store, 'refresh')).toBe('committed')
    expect(await fixture.createStore().inspect()).toEqual({
      status: 'ready',
      refreshToken: REFRESH_1
    })
    expect(await fs.readdir(fixture.directory)).toEqual(['credential.v1'])
  })

  it('재확립한 marker 뒤 이전 temp 정리가 실패하면 writer 준비 성공을 반환하지 않는다', async () => {
    await fixture.seedReady()
    fixture.failures.set('rename:transition.v1', ['before'])
    fixture.failures.set('unlink:transition-temp', ['before'])

    expect(await prepareCredentialTransition(fixture.store, 'refresh')).toBe('unconfirmed')
    expect(await fixture.store.commitCredential(REFRESH_1)).toBe('failed')
    expect(await fixture.createStore().inspect()).toEqual({ status: 'recovery-required' })
  })

  it.each([true, false])(
    'marker unlink 뒤 sync 실패와 재확립 성공=%s를 구분한다',
    async (canReestablish) => {
      await fixture.seedReady()
      await fixture.store.establishTransition('refresh')
      await fixture.store.commitCredential(REFRESH_1)
      fixture.failures.set('sync:directory', ['before'])
      if (!canReestablish) {
        fixture.failures.set('open:transition-temp', ['before'])
      }

      expect(await finalizeCredentialTransition(fixture.store, 'refresh')).toBe(
        canReestablish ? 'save-failed' : 'clear-unconfirmed'
      )
      expect(await fixture.createStore().inspect()).toEqual(
        canReestablish
          ? { status: 'recovery-required' }
          : { status: 'ready', refreshToken: REFRESH_1 }
      )
    }
  )

  it.each([true, false])(
    'marker unlink 적용 뒤 reject에도 재확립 성공=%s를 정확히 전달한다',
    async (canReestablish) => {
      await fixture.seedReady()
      await fixture.store.establishTransition('refresh')
      await fixture.store.commitCredential(REFRESH_1)
      fixture.failures.set('unlink:transition.v1', ['after'])
      if (!canReestablish) fixture.failures.set('open:transition-temp', ['before'])

      expect(await finalizeCredentialTransition(fixture.store, 'refresh')).toBe(
        canReestablish ? 'save-failed' : 'clear-unconfirmed'
      )
      expect(await fixture.createStore().inspect()).toEqual(
        canReestablish
          ? { status: 'recovery-required' }
          : { status: 'ready', refreshToken: REFRESH_1 }
      )
    }
  )

  it('credential unlink 적용 뒤 reject는 local clear 완료로 오인하지 않는다', async () => {
    await fixture.seedReady()
    fixture.failures.set('unlink:credential.v1', ['after'])

    expect(await clearCredential(fixture.store)).toBe('unconfirmed')
    expect(await fixture.createStore().inspect()).toEqual({ status: 'recovery-required' })
    expect(fixture.events).not.toContain('unlink:transition.v1')
  })

  it.each(['malformed', 'unknown-schema', 'permission', 'symlink', 'directory'] as const)(
    'transition.v1의 %s는 ready 복원·복호화를 허용하지 않는다',
    async (kind) => {
      await fixture.seedReady()
      const path = join(fixture.directory, 'transition.v1')
      const isSymlink = kind === 'symlink'
      const isDirectory = kind === 'directory'
      const hasPermissionError = kind === 'permission'
      const isMalformed = kind === 'malformed'
      const unrelated = join(fixture.userDataPath, 'marker-unrelated')
      if (isSymlink) {
        await fs.writeFile(unrelated, 'unrelated', { mode: 0o600 })
        await fs.symlink(unrelated, path)
      } else if (isDirectory) {
        await fs.mkdir(path, { mode: 0o700 })
      } else {
        await fs.writeFile(path, isMalformed ? '{' : '{"version":999}', {
          mode: hasPermissionError ? 0o644 : 0o600
        })
      }

      const hasProtectionError = isSymlink || isDirectory || hasPermissionError
      expect(await fixture.createStore().inspect()).toEqual({
        status: hasProtectionError ? 'unavailable' : 'recovery-required'
      })
      expect(fixture.safeStorage.decryptString).not.toHaveBeenCalled()
      if (isSymlink) expect(await fs.readFile(unrelated, 'utf8')).toBe('unrelated')
    }
  )

  it.each(['unlink:credential.v1', 'sync:directory', 'unlink:transition.v1'])(
    '삭제의 %s 실패는 clean 성공으로 전달하지 않는다',
    async (event) => {
      await fixture.seedReady()
      await fixture.store.establishTransition('clear')
      fixture.failures.set(event, ['before'])

      const cleared = await fixture.store.clearCredential()
      const removed = cleared === 'confirmed' ? await fixture.store.removeTransition() : cleared
      expect(removed).not.toBe('confirmed')
      expect(await fixture.createStore().inspect()).toEqual({ status: 'recovery-required' })
    }
  )
})
