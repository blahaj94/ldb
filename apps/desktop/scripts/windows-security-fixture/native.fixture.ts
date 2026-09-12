import { readFile, symlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import koffi from 'koffi'
import { expect, it } from 'vitest'
import {
  createWindowsSecurityApiForTesting,
  createWindowsSecurityNative,
  type WindowsSecurityApi
} from '../../src/backend/auth/windows-security-native'
import { createWindowsCredentialNative } from '../../src/backend/auth/credential-store/windows-credential-native'
import { WindowsCredentialFiles } from '../../src/backend/auth/credential-store/windows-credential-files'
import { createFixtureRoot, fixturePath, runFixtureLifecycle } from './isolation'

function observeApi(): {
  api: WindowsSecurityApi
  observations: Record<string, number>
  withAdditionalAce(create: () => void): void
  releaseRemaining(): boolean
  assertReleased(): void
} {
  const real = createWindowsSecurityApiForTesting((name) => koffi.load(name))
  const handles = new Set<bigint>()
  const descriptors = new Set<bigint>()
  const observations = {
    opened: 0,
    closed: 0,
    freed: 0,
    sidMatches: 0,
    listBatches: 0,
    flushSucceeded: 0,
    flushFailed: 0,
    renameSucceeded: 0,
    dispositionSucceeded: 0
  }
  let addAce = false
  let releaseFailed = false
  const api: WindowsSecurityApi = {
    ...real,
    createFile: (...args) => {
      const handle = real.createFile(...args)
      const isValid = handle != null && handle !== 0xffffffffffffffffn && handle !== 0xffffffffn
      if (isValid) {
        handles.add(handle)
        observations.opened += 1
      }
      return handle
    },
    openProcessToken: (...args) => {
      const success = real.openProcessToken(...args)
      const handle = args[2][0]
      const hasHandle = success && handle != null
      if (hasHandle) {
        handles.add(handle)
        observations.opened += 1
      }
      return success
    },
    closeHandle: (handle) => {
      const success = real.closeHandle(handle)
      if (success) {
        handles.delete(handle)
        observations.closed += 1
      } else {
        releaseFailed = true
      }
      return success
    },
    getSecurityInfo: (...args) => {
      const result = real.getSecurityInfo(...args)
      const descriptor = args[7][0]
      const hasDescriptor = descriptor != null
      if (hasDescriptor) {
        descriptors.add(descriptor)
      }
      return result
    },
    convertStringSecurityDescriptorToSecurityDescriptor: (sddl, ...args) => {
      // Modify only this synthetic directory's descriptor; never log the SID.
      const descriptorText = addAce ? `${sddl}(A;;FR;;;WD)` : sddl
      const result = real.convertStringSecurityDescriptorToSecurityDescriptor(
        descriptorText,
        ...args
      )
      const descriptor = args[1][0]
      const hasDescriptor = descriptor != null
      if (hasDescriptor) {
        descriptors.add(descriptor)
      }
      return result
    },
    localFree: (descriptor) => {
      const result = real.localFree(descriptor)
      const released = result == null
      if (released) {
        descriptors.delete(descriptor)
        observations.freed += 1
      } else {
        releaseFailed = true
      }
      return result
    },
    equalSid: (...args) => {
      const result = real.equalSid(...args)
      if (result) {
        observations.sidMatches += 1
      }
      return result
    },
    getDirectoryEntries: (...args) => {
      const result = real.getDirectoryEntries(...args)
      if (result) {
        observations.listBatches += 1
      }
      return result
    },
    flushFileBuffers: (handle) => {
      const result = real.flushFileBuffers(handle)
      if (result) {
        observations.flushSucceeded += 1
      } else {
        observations.flushFailed += 1
      }
      return result
    },
    setFileInformationByHandle: (...args) => {
      const result = real.setFileInformationByHandle(...args)
      const renamed = result && args[1] === 3
      const disposed = result && args[1] === 4
      if (renamed) {
        observations.renameSucceeded += 1
      }
      if (disposed) {
        observations.dispositionSucceeded += 1
      }
      return result
    }
  }
  return {
    api,
    observations,
    withAdditionalAce: (create: () => void) => {
      addAce = true
      try {
        create()
      } finally {
        addAce = false
      }
    },
    releaseRemaining: () => {
      for (const handle of handles) {
        api.closeHandle(handle)
      }
      for (const descriptor of descriptors) {
        api.localFree(descriptor)
      }
      const allReleased = handles.size === 0 && descriptors.size === 0 && !releaseFailed
      return allReleased
    },
    assertReleased: () => {
      expect(handles.size).toBe(0)
      expect(descriptors.size).toBe(0)
      expect(releaseFailed).toBe(false)
    }
  }
}

it('observes synthetic Win32 files without enabling product capabilities', async () => {
  const isWindows = process.platform === 'win32'
  if (!isWindows) {
    throw new Error('Synthetic Win32 fixture requires Windows.')
  }
  const observed = observeApi()
  const native = createWindowsSecurityNative({ api: observed.api })
  const inspectReparse = (path: string): boolean => {
    const inspection = native.inspect(path, 'directory', 'ancestor')
    const isUncertain = inspection === 'missing' || inspection === 'unavailable'
    if (isUncertain) {
      throw new Error('Synthetic cleanup native inspection is unavailable.')
    }
    const isReparse = inspection === 'reparse'
    return isReparse
  }
  let stage = 'setup'
  let directoryFlush = 'not-observed'
  let listedBytes = 0
  let nativeListBatches = 0
  const write = (path: string, payload = 'synthetic bytes'): void => {
    const handle = native.createExclusive(path)
    try {
      expect(typeof handle).toBe('bigint')
      native.writeFile(handle, Buffer.from(payload))
    } finally {
      expect(native.closeHandle(handle)).toBe(true)
    }
  }
  const { failure, cleanup } = await runFixtureLifecycle({
    create: () => createFixtureRoot(resolve(tmpdir()), { inspectReparse }),
    releaseResources: observed.releaseRemaining,
    observe: async (fixture) => {
      const nativeAdapter = createWindowsCredentialNative()
      const profile = fixturePath(fixture, 'profile')
      const auth = fixturePath(fixture, 'profile', 'auth')
      const directory = fixturePath(fixture, 'profile', 'auth', 'synthetic')
      for (const path of [profile, auth, directory]) {
        expect(native.createDirectory(path)).toBe('created')
        expect(native.inspect(path, 'directory')).toBe('trusted')
      }
      expect(native.createDirectory(directory)).toBe('already-exists')
      expect(native.list(directory)).toEqual([])
      expect(native.inspect(fixturePath(fixture, 'missing'), 'file')).toBe('missing')

      stage = 'unicode-multiple-batches'
      const names = [
        'credential.v1',
        'transition.v1',
        '한글-😀.txt',
        'sentinel',
        '.credential.v1.11111111-1111-4111-8111-111111111111.tmp',
        '.transition.v1.22222222-2222-4222-8222-222222222222.tmp',
        '.credential.v1.not-a-uuid.tmp',
        '.credential.v1.11111111-1111-4111-8111-111111111111.tmp.extra'
      ]
      for (let index = 0; index < 400; index += 1) {
        names.push(`synthetic-${index}-${'x'.repeat(100)}.txt`)
      }
      for (const name of names) {
        write(fixturePath(fixture, 'profile', 'auth', 'synthetic', name))
      }
      listedBytes = names.reduce(
        (bytes, name) => bytes + 68 + Buffer.byteLength(name, 'utf16le'),
        0
      )
      expect(listedBytes).toBeGreaterThan(64 * 1024)
      const beforeBatches = observed.observations.listBatches
      const listed = native.list(directory)
      expect(listed.sort()).toEqual([...names].sort())
      nativeListBatches = observed.observations.listBatches - beforeBatches
      expect(nativeListBatches).toBeGreaterThan(1)

      stage = 'handle-read-and-exclusive-collision'
      const sentinel = fixturePath(fixture, 'profile', 'auth', 'synthetic', 'sentinel')
      expect(() => native.createExclusive(sentinel)).toThrow()
      const readHandle = native.openRead(sentinel)
      try {
        const buffer = Buffer.alloc(64)
        const length = native.readFile(readHandle, buffer, buffer.length)
        expect(buffer.subarray(0, length).toString()).toBe('synthetic bytes')
      } finally {
        expect(native.closeHandle(readHandle)).toBe(true)
      }

      stage = 'acl-reparse-and-type-rejection'
      const extraAce = fixturePath(fixture, 'extra-ace')
      observed.withAdditionalAce(() => native.createDirectory(extraAce))
      expect(native.inspect(extraAce, 'directory')).toBe('untrusted')
      expect(() => native.list(extraAce)).toThrow()
      expect(native.inspect(sentinel, 'directory')).toBe('untrusted')
      expect(() => native.openRead(directory)).toThrow()
      const junction = fixturePath(fixture, 'junction')
      await symlink(directory, junction, 'junction')
      expect(native.inspect(junction, 'directory')).toBe('reparse')
      expect(() => native.list(junction)).toThrow()
      expect(await readFile(sentinel, 'utf8')).toBe('synthetic bytes')

      stage = 'owned-temporary-selection'
      expect(nativeAdapter.capabilities).toEqual({
        profileProtection: 'unknown',
        fileMutation: 'unknown',
        namespaceMutation: 'unknown'
      })
      // Only list/name selection is exercised. prepare() and mutation gates stay closed.
      const files = new WindowsCredentialFiles(profile, 'synthetic', {
        ...nativeAdapter,
        list: async (path) => native.list(path)
      })
      const owned = await files.ownedTemporaries()
      expect(owned).toEqual(names.slice(4, 6))
      for (const name of owned) {
        native.remove(fixturePath(fixture, 'profile', 'auth', 'synthetic', name))
      }
      const survivors = native.list(directory)
      expect(survivors.sort()).toEqual(names.filter((name) => !owned.includes(name)).sort())

      stage = 'flush-rename-disposition-close'
      const source = fixturePath(fixture, 'mutation-source')
      const destination = fixturePath(fixture, 'mutation-destination')
      const handle = native.createExclusive(source)
      try {
        native.writeFile(handle, Buffer.from('synthetic mutation'))
        native.flushFileBuffers(handle)
        native.renameFile(handle, destination)
        native.flushFileBuffers(handle)
      } finally {
        expect(native.closeHandle(handle)).toBe(true)
      }
      expect(native.inspect(source, 'file')).toBe('missing')
      expect(await readFile(destination, 'utf8')).toBe('synthetic mutation')
      native.remove(destination)
      expect(native.inspect(destination, 'file')).toBe('missing')
      try {
        native.syncDirectory(directory)
        directoryFlush = 'returned-success'
      } catch {
        directoryFlush = 'returned-failure'
      }
      observed.assertReleased()
      expect(observed.observations.sidMatches).toBeGreaterThan(0)
      expect(observed.observations.renameSucceeded).toBe(1)
      expect(observed.observations.dispositionSucceeded).toBe(3)
    }
  })
  console.log(
    JSON.stringify({
      evidence: 'synthetic-win32-observation',
      stage,
      failure,
      directoryFlush,
      cleanup,
      listedBytes,
      nativeListBatches,
      capabilities: 'unknown',
      namespaceDurability: 'unverified',
      ...observed.observations
    })
  )
  expect(cleanup).toBe('clean')
  expect(failure, `Synthetic Win32 case failed: ${stage}`).toBe(false)
})
