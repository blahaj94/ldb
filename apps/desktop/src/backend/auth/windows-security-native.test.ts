import koffi, { type TypeObject } from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import {
  createWindowsSecurityApiForTesting,
  createWindowsSecurityNative,
  getWindowsSecurityBindingContractForTesting,
  type WindowsSecurityApi
} from './windows-security-native'

const FILE_ATTRIBUTE_DIRECTORY = 0x10
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400
const FILE_ALL_ACCESS = 0x001f01ff
const DELETE_ACCESS = 0x00010000
const ERROR_INSUFFICIENT_BUFFER = 122
type TestWindowsLibrary = Readonly<{
  func(...args: unknown[]): (...runtimeArgs: unknown[]) => unknown
}>
type TestHandleMode = 'normal' | 'null' | 'invalid'

function writeTokenUserBuffer(target: Buffer, sidData: Buffer): void {
  const sidOffset = process.arch === 'ia32' ? 4 : 8
  target.fill(0)
  sidData.copy(target, sidOffset)
  const sidPointer = koffi.address(target.subarray(sidOffset, sidOffset + sidData.length))
  if (process.arch === 'ia32') {
    target.writeUInt32LE(Number(sidPointer), 0)
  } else {
    target.writeBigUInt64LE(sidPointer, 0)
  }
}

type SecurityFixture = {
  api: WindowsSecurityApi
  set: (options: {
    attributes?: number
    daclPresent?: number
    aceCount?: number
    aceType?: number
    aceFlags?: number
    accessMask?: number
    ownerIsCurrent?: boolean
    aceIsCurrent?: boolean
  }) => void
}

function createSecurityFixture(): SecurityFixture {
  const currentSidData = Buffer.from([
    1, 4, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 42, 0, 0, 0, 43, 0, 0, 0, 44, 0, 0, 0
  ])
  const otherSidData = Buffer.from([
    1, 4, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 52, 0, 0, 0, 53, 0, 0, 0, 54, 0, 0, 0
  ])
  const otherSidPointer = koffi.address(otherSidData)
  const sidOffset = process.arch === 'ia32' ? 4 : 8
  const tokenData = Buffer.alloc(sidOffset + currentSidData.length)
  writeTokenUserBuffer(tokenData, currentSidData)
  const currentSidPointer = koffi.address(
    tokenData.subarray(sidOffset, sidOffset + currentSidData.length)
  )
  let attributes = FILE_ATTRIBUTE_DIRECTORY
  let daclPresent = 1
  let aceCount = 1
  let aceType = 0
  let aceFlags = 0
  let accessMask = FILE_ALL_ACCESS
  let ownerIsCurrent = true
  let aceIsCurrent = true
  const dacl = 102n
  let aceData = Buffer.alloc(8 + currentSidData.length)

  const api: WindowsSecurityApi = {
    closeHandle: () => true,
    createDirectory: () => true,
    createFile: () => 103n,
    flushFileBuffers: () => true,
    getFileInformationByHandleEx: (_handle, _class, information) => {
      information.FileAttributes = attributes
      return true
    },
    getDirectoryEntries: () => false,
    getCurrentProcess: () => 104n,
    getLastError: () => ERROR_INSUFFICIENT_BUFFER,
    getLengthSid: () => currentSidData.length,
    getSecurityDescriptorDacl: (_descriptor, present, daclOut) => {
      present[0] = daclPresent
      daclOut[0] = daclPresent === 0 ? null : dacl
      return true
    },
    getSecurityInfo: (
      _handle,
      _objectType,
      _securityInformation,
      owner,
      _group,
      _dacl,
      _sacl,
      descriptorOut
    ) => {
      owner[0] = ownerIsCurrent ? currentSidPointer : otherSidPointer
      descriptorOut[0] = 101n
      return 0
    },
    getTokenInformation: (_token, _class, data, _length, returnLength) => {
      if (data == null) {
        returnLength[0] = tokenData.length
        return false
      }
      writeTokenUserBuffer(data, currentSidData)
      return true
    },
    getAclInformation: (_dacl, information) => {
      information.AceCount = aceCount
      return true
    },
    getAce: (_dacl, _index, ace) => {
      ace[0] = koffi.address(aceData)
      return true
    },
    isValidSid: () => true,
    equalSid: (left, right) => {
      const currentSidCast = typeof right === 'object' && right != null
      if (left === currentSidPointer && currentSidCast) {
        return ownerIsCurrent
      }
      return typeof left === 'object' && left != null && currentSidCast && aceIsCurrent
    },
    localFree: () => null,
    openProcessToken: (_process, _access, token) => {
      token[0] = 105n
      return true
    },
    convertStringSecurityDescriptorToSecurityDescriptor: () => true,
    readFile: () => true,
    writeFile: () => true,
    setFileInformationByHandle: () => true
  }
  const set = (options: Parameters<SecurityFixture['set']>[0]): void => {
    attributes = options.attributes ?? FILE_ATTRIBUTE_DIRECTORY
    daclPresent = options.daclPresent ?? 1
    aceCount = options.aceCount ?? 1
    aceType = options.aceType ?? 0
    aceFlags = options.aceFlags ?? 0
    accessMask = options.accessMask ?? FILE_ALL_ACCESS
    ownerIsCurrent = options.ownerIsCurrent ?? true
    aceIsCurrent = options.aceIsCurrent ?? true
    const sidData = aceIsCurrent ? currentSidData : otherSidData
    aceData = Buffer.alloc(8 + sidData.length)
    aceData[0] = aceType
    aceData[1] = aceFlags
    aceData.writeUInt16LE(aceData.length, 2)
    aceData.writeUInt32LE(accessMask, 4)
    sidData.copy(aceData, 8)
  }
  set({})
  return { api, set }
}

function directoryBatch(names: string[]): Buffer {
  const entries = names.map((name) => {
    const filename = Buffer.from(name, 'utf16le')
    const entry = Buffer.alloc(Math.ceil((68 + filename.length) / 8) * 8)
    entry.writeUInt32LE(entry.length, 0)
    entry.writeUInt32LE(filename.length, 60)
    filename.copy(entry, 68)
    return entry
  })
  entries.at(-1)?.writeUInt32LE(0, 0)
  return Buffer.concat(entries)
}

type EnumerationFixture = SecurityFixture & {
  native: ReturnType<typeof createWindowsSecurityNative>
  query: ReturnType<typeof vi.fn<WindowsSecurityApi['getDirectoryEntries']>>
  closeHandle: ReturnType<typeof vi.fn<WindowsSecurityApi['closeHandle']>>
  createFile: ReturnType<typeof vi.fn<WindowsSecurityApi['createFile']>>
}

function createEnumerationFixture(batches: Buffer[], terminalError = 18): EnumerationFixture {
  const fixture = createSecurityFixture()
  let batchIndex = 0
  let lastError = ERROR_INSUFFICIENT_BUFFER
  const query = vi.fn((_handle: bigint, _class: number, buffer: Buffer, size: number) => {
    expect(size).toBe(buffer.byteLength)
    expect(koffi.address(buffer) % 8n).toBe(0n)
    const batch = batches[batchIndex++]
    const hasBatch = batch != null
    if (!hasBatch) {
      lastError = terminalError
      return false
    }
    batch.copy(buffer)
    return true
  })
  const closeHandle = vi.fn<WindowsSecurityApi['closeHandle']>(() => true)
  const createFile = vi.fn(fixture.api.createFile)
  const api = {
    ...fixture.api,
    createFile,
    closeHandle,
    getLastError: () => lastError,
    getDirectoryEntries: query
  }
  return {
    ...fixture,
    native: createWindowsSecurityNative({ api }),
    query,
    closeHandle,
    createFile
  }
}

describe('Windows directory enumeration', () => {
  it('reads all batches on the checked directory handle and skips only dot entries', () => {
    const fixture = createEnumerationFixture([
      directoryBatch(['.', '..', 'credential.v1', '한글.txt']),
      directoryBatch(['transition.v1'])
    ])

    expect(fixture.native.list(String.raw`C:\LdbProfile\auth\test`)).toEqual([
      'credential.v1',
      '한글.txt',
      'transition.v1'
    ])
    expect(fixture.query.mock.calls.map((call) => call[1])).toEqual([15, 14, 14])
    expect(fixture.query.mock.calls.map((call) => call[0])).toEqual([103n, 103n, 103n])
    expect(fixture.createFile).toHaveBeenCalledWith(
      String.raw`C:\LdbProfile\auth\test`,
      0x20081,
      7,
      null,
      3,
      0x2200000,
      null
    )
    expect(fixture.closeHandle.mock.calls.filter(([handle]) => handle === 103n)).toHaveLength(1)
  })

  it('returns an empty directory only after the explicit enumeration end', () => {
    const fixture = createEnumerationFixture([])

    expect(fixture.native.list('directory')).toEqual([])
    expect(fixture.closeHandle).toHaveBeenCalledWith(103n)
  })

  it.each([null, 0xffffffffffffffffn])(
    'rejects an invalid open handle %s without using it',
    (handle) => {
      const fixture = createEnumerationFixture([])
      fixture.createFile.mockReturnValue(handle)

      expect(() => fixture.native.list('directory')).toThrow()
      expect(fixture.query).not.toHaveBeenCalled()
      expect(fixture.closeHandle).not.toHaveBeenCalled()
    }
  )

  it('closes the directory handle if the query throws', () => {
    const fixture = createEnumerationFixture([])
    fixture.query.mockImplementation(() => {
      throw new Error('Synthetic query failure.')
    })

    expect(() => fixture.native.list('directory')).toThrow()
    expect(fixture.closeHandle).toHaveBeenCalledWith(103n)
  })

  it('clears the reused buffer so an incomplete batch cannot reuse stale names', () => {
    const fixture = createEnumerationFixture([
      directoryBatch(['credential.v1', 'transition.v1']),
      Buffer.alloc(4)
    ])

    expect(() => fixture.native.list('directory')).toThrow()
    expect(fixture.query).toHaveBeenCalledTimes(2)
    expect(fixture.query.mock.calls[0][2]).toBe(fixture.query.mock.calls[1][2])
    expect(fixture.closeHandle).toHaveBeenCalledWith(103n)
  })

  it('rejects a next offset that leaves an incomplete header at the buffer end', () => {
    const fixture = createEnumerationFixture([])
    fixture.query.mockImplementation((_handle, _class, buffer) => {
      directoryBatch(['credential.v1']).copy(buffer)
      buffer.writeUInt32LE(buffer.byteLength - 8, 0)
      return true
    })

    expect(() => fixture.native.list('directory')).toThrow()
    expect(fixture.query).toHaveBeenCalledOnce()
    expect(fixture.closeHandle).toHaveBeenCalledWith(103n)
  })

  it.each([2, 3, 5, 38, 87, 122, 234])('throws on error %s after a partial batch', (error) => {
    const fixture = createEnumerationFixture([directoryBatch(['credential.v1'])], error)

    expect(() => fixture.native.list('directory')).toThrow()
    expect(fixture.query).toHaveBeenCalledTimes(2)
    expect(fixture.closeHandle.mock.calls.filter(([handle]) => handle === 103n)).toHaveLength(1)
  })

  it.each([
    { attributes: FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT },
    { attributes: 0 },
    { ownerIsCurrent: false },
    { daclPresent: 0 },
    { aceIsCurrent: false }
  ])('rejects an unsafe directory before querying: %j', (inspection) => {
    const fixture = createEnumerationFixture([])
    fixture.set(inspection)

    expect(() => fixture.native.list('directory')).toThrow()
    expect(fixture.query).not.toHaveBeenCalled()
    expect(fixture.closeHandle).toHaveBeenCalledWith(103n)
  })

  it('does not expose a completed list when its directory handle cannot close', () => {
    const fixture = createEnumerationFixture([directoryBatch(['credential.v1'])])
    fixture.closeHandle.mockImplementation((handle) => handle !== 103n)

    expect(() => fixture.native.list('directory')).toThrow()
    expect(fixture.closeHandle.mock.calls.filter(([handle]) => handle === 103n)).toHaveLength(1)
  })

  it.each([
    ['zero name length', (data: Buffer) => data.writeUInt32LE(0, 60)],
    ['odd name length', (data: Buffer) => data.writeUInt32LE(3, 60)],
    ['name past buffer', (data: Buffer) => data.writeUInt32LE(0xfffffffe, 60)],
    ['overlapping next entry', (data: Buffer) => data.writeUInt32LE(8, 0)],
    ['unaligned next entry', (data: Buffer) => data.writeUInt32LE(71, 0)],
    ['next entry past buffer', (data: Buffer) => data.writeUInt32LE(0xfffffff8, 0)]
  ])('rejects %s and releases the directory handle', (_label, corrupt) => {
    const batch = directoryBatch(['credential.v1'])
    corrupt(batch)
    const fixture = createEnumerationFixture([batch])

    expect(() => fixture.native.list('directory')).toThrow()
    expect(fixture.closeHandle).toHaveBeenCalledWith(103n)
  })

  it.each(['a/b', 'a\\b', 'a\0b', 'a:b', '\ud800', 'credential.v1.', 'credential.v1 '])(
    'rejects an unsafe returned filename %j',
    (name) => {
      const fixture = createEnumerationFixture([directoryBatch([name])])

      expect(() => fixture.native.list('directory')).toThrow()
      expect(fixture.closeHandle).toHaveBeenCalledWith(103n)
    }
  )
})

describe('Windows directory flush', () => {
  it('opens the checked directory with GENERIC_WRITE required by FlushFileBuffers', () => {
    const fixture = createSecurityFixture()
    const createFile = vi.fn(fixture.api.createFile)
    const flushFileBuffers = vi.fn(fixture.api.flushFileBuffers)
    const closeHandle = vi.fn(fixture.api.closeHandle)
    const native = createWindowsSecurityNative({
      api: { ...fixture.api, createFile, flushFileBuffers, closeHandle }
    })

    native.syncDirectory('directory')

    const desiredAccess = createFile.mock.calls[0][1]
    expect(desiredAccess & 0x40000000).toBe(0x40000000)
    expect(createFile).toHaveBeenCalledExactlyOnceWith(
      'directory',
      desiredAccess,
      7,
      null,
      3,
      0x2200000,
      null
    )
    expect(flushFileBuffers).toHaveBeenCalledExactlyOnceWith(103n)
    expect(closeHandle.mock.calls.filter(([handle]) => handle === 103n)).toHaveLength(1)
  })
})

describe('Windows directory flush failure guards', () => {
  it.each([null, 0xffffffffffffffffn])(
    'rejects invalid handle %s before inspection or flush',
    (handle) => {
      const fixture = createSecurityFixture()
      const inspect = vi.fn(fixture.api.getFileInformationByHandleEx)
      const flush = vi.fn(fixture.api.flushFileBuffers)
      const close = vi.fn(fixture.api.closeHandle)
      const native = createWindowsSecurityNative({
        api: {
          ...fixture.api,
          createFile: () => handle,
          getFileInformationByHandleEx: inspect,
          flushFileBuffers: flush,
          closeHandle: close
        }
      })

      expect(() => native.syncDirectory('directory')).toThrow()
      expect(inspect).not.toHaveBeenCalled()
      expect(flush).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
    }
  )

  it.each([
    { attributes: FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT },
    { attributes: 0 },
    { ownerIsCurrent: false },
    { daclPresent: 0 },
    { aceIsCurrent: false }
  ])('rejects unsafe directory before flush: %j', (inspection) => {
    const fixture = createSecurityFixture()
    fixture.set(inspection)
    const flush = vi.fn(fixture.api.flushFileBuffers)
    const close = vi.fn(fixture.api.closeHandle)
    const native = createWindowsSecurityNative({
      api: {
        ...fixture.api,
        flushFileBuffers: flush,
        closeHandle: close
      }
    })

    expect(() => native.syncDirectory('directory')).toThrow()
    expect(flush).not.toHaveBeenCalled()
    expect(close.mock.calls.filter(([handle]) => handle === 103n)).toHaveLength(1)
  })

  it.each(['failure', 'exception'] as const)(
    'closes the checked directory after flush %s',
    (failure) => {
      const fixture = createSecurityFixture()
      const close = vi.fn(fixture.api.closeHandle)
      const flush = vi.fn(() => {
        const shouldThrow = failure === 'exception'
        if (shouldThrow) {
          throw new Error('Synthetic flush exception.')
        }
        return false
      })
      const native = createWindowsSecurityNative({
        api: {
          ...fixture.api,
          flushFileBuffers: flush,
          closeHandle: close
        }
      })

      expect(() => native.syncDirectory('directory')).toThrow()
      expect(flush).toHaveBeenCalledExactlyOnceWith(103n)
      expect(close.mock.calls.filter(([handle]) => handle === 103n)).toHaveLength(1)
    }
  )

  it.each(['flush', 'disposition'] as const)(
    'rejects close failure after successful %s',
    (operation) => {
      const fixture = createSecurityFixture()
      const isDeletion = operation === 'disposition'
      fixture.set({ attributes: isDeletion ? 0 : FILE_ATTRIBUTE_DIRECTORY })
      const close = vi.fn((handle) => handle !== 103n)
      const flush = vi.fn(fixture.api.flushFileBuffers)
      const disposition = vi.fn(fixture.api.setFileInformationByHandle)
      const native = createWindowsSecurityNative({
        api: {
          ...fixture.api,
          flushFileBuffers: flush,
          setFileInformationByHandle: disposition,
          closeHandle: close
        }
      })

      expect(() =>
        isDeletion ? native.remove('file') : native.syncDirectory('directory')
      ).toThrow()
      if (isDeletion) {
        expect(disposition).toHaveBeenCalledExactlyOnceWith(103n, 4, Buffer.from([1]), 1)
      } else {
        expect(flush).toHaveBeenCalledExactlyOnceWith(103n)
      }
      expect(close.mock.calls.filter(([handle]) => handle === 103n)).toHaveLength(1)
    }
  )
})

describe('Windows security native boundary', () => {
  it('binds the complete Win32 call signatures required by the adapter', () => {
    const declarations: Array<{ library: string; name: string; args: unknown[] }> = []
    const loader = (library: string): TestWindowsLibrary => ({
      func: (...args: unknown[]) => {
        declarations.push({ library, name: String(args[1]), args })
        return (() => undefined) as (...runtimeArgs: unknown[]) => unknown
      }
    })

    createWindowsSecurityApiForTesting(loader)

    const declaration = (name: string): unknown[] =>
      declarations.find((entry) => entry.name === name)?.args ?? []
    expect(declaration('CreateFileW')[3]).toHaveLength(7)
    expect(declaration('GetFileInformationByHandleEx')[3]).toHaveLength(4)
    expect(declaration('GetAclInformation')[3]).toHaveLength(4)
    expect(declaration('ReadFile')[3]).toHaveLength(5)
    expect(declaration('WriteFile')[3]).toHaveLength(5)
    expect(declaration('SetFileInformationByHandle')[3]).toHaveLength(4)
    expect(getWindowsSecurityBindingContractForTesting().getAceOutputTypeName).toMatch(/\*\*$/)
    const directoryDeclarations = declarations.filter((entry) => {
      const hasFunction = entry.name === 'GetFileInformationByHandleEx'
      const hasDirectoryResult = entry.args[2] === 'int32_t'
      return hasFunction && hasDirectoryResult
    })
    expect(directoryDeclarations).toHaveLength(1)
    const directoryDeclaration = directoryDeclarations[0]
    expect(directoryDeclaration.library).toBe('kernel32.dll')
    expect(directoryDeclaration.args[0]).toBe('__stdcall')
    const directoryArguments = directoryDeclaration.args[3] as Parameters<typeof koffi.proto>[3]
    const prototype = koffi.proto('__stdcall', null, 'int32_t', directoryArguments).proto
    expect(prototype?.result).toMatchObject({ primitive: 'Int32', size: 4 })
    expect(prototype?.arguments).toMatchObject([
      { direction: 'Input', type: { primitive: 'Pointer', ref: { primitive: 'Void' } } },
      { direction: 'Input', type: { primitive: 'UInt32', size: 4 } },
      { direction: 'Output', type: { primitive: 'Pointer', ref: { primitive: 'UInt8' } } },
      { direction: 'Input', type: { primitive: 'UInt32', size: 4 } }
    ])
  })

  it('routes adapter calls through a strict fake DLL with required NULLs and sizes', () => {
    const currentSidData = Buffer.from([
      1, 4, 0, 0, 0, 0, 0, 5, 21, 0, 0, 0, 42, 0, 0, 0, 43, 0, 0, 0, 44, 0, 0, 0
    ])
    const sidOffset = process.arch === 'ia32' ? 4 : 8
    const tokenData = Buffer.alloc(sidOffset + currentSidData.length)
    writeTokenUserBuffer(tokenData, currentSidData)
    const currentSidPointer = koffi.address(
      tokenData.subarray(sidOffset, sidOffset + currentSidData.length)
    )
    const aceData = Buffer.alloc(8 + currentSidData.length)
    aceData[0] = 0
    aceData.writeUInt16LE(aceData.length, 2)
    aceData.writeUInt32LE(FILE_ALL_ACCESS, 4)
    currentSidData.copy(aceData, 8)
    const acePointer = koffi.address(aceData)
    const arities = new Map<string, number[]>()
    let handleMode: TestHandleMode = 'normal'
    let returnOutOfRangeTokenSid = false
    let failLocalFree = false
    let closeCount = 0
    let createdHandleCloseCount = 0
    const equalSidCurrentArguments: unknown[] = []
    const getLengthSidArguments: unknown[] = []
    let lastError = ERROR_INSUFFICIENT_BUFFER
    let handleType: TypeObject | null = null
    let normalHandle: bigint | null = null
    let nullHandle: bigint | null = null
    let invalidHandle: bigint | null = null
    let handleKind: 'directory' | 'file' = 'directory'
    const record = (name: string, args: unknown[]): void => {
      const values = arities.get(name) ?? []
      values.push(args.length)
      arities.set(name, values)
    }
    const loader = (library: string): TestWindowsLibrary => ({
      func: (...definition: unknown[]) => {
        const name = String(definition[1])
        if (name === 'CreateFileW') {
          handleType = definition[2] as TypeObject
        }
        return (...args: unknown[]): unknown => {
          record(name, args)
          const requiredArity =
            name === 'CreateFileW'
              ? 7
              : name === 'GetFileInformationByHandleEx' || name === 'GetAclInformation'
                ? 4
                : name === 'ReadFile' || name === 'WriteFile'
                  ? 5
                  : name === 'SetFileInformationByHandle'
                    ? 4
                    : null
          if (requiredArity != null && args.length !== requiredArity) {
            throw new Error(`${name} received ${args.length} arguments`)
          }
          switch (name) {
            case 'CloseHandle':
              closeCount += 1
              if (args[0] === 103n) {
                createdHandleCloseCount += 1
              }
              return true
            case 'CreateFileW':
              if (args[6] !== null) {
                throw new Error('CreateFileW hTemplateFile must be NULL')
              }
              if (String(args[0]).includes('.tmp') && (Number(args[1]) & DELETE_ACCESS) === 0) {
                throw new Error('CreateFileW rename handle must have DELETE access')
              }
              handleKind =
                String(args[0]).includes('credential.v1') || String(args[0]).includes('.tmp')
                  ? 'file'
                  : 'directory'
              if (handleMode === 'null') {
                return nullHandle
              }
              if (handleMode === 'invalid') {
                return invalidHandle
              }
              return normalHandle
            case 'GetFileInformationByHandleEx':
              if (typeof args[3] !== 'number' || args[3] <= 0) {
                throw new Error('GetFileInformationByHandleEx size is required')
              }
              ;(args[2] as Record<string, unknown>).FileAttributes =
                String(args[0]).includes('credential.v1') || String(args[0]).includes('.tmp')
                  ? 0
                  : handleKind === 'directory'
                    ? FILE_ATTRIBUTE_DIRECTORY
                    : 0
              return true
            case 'GetSecurityInfo':
              ;(args[3] as Array<unknown>)[0] = currentSidPointer
              ;(args[7] as Array<unknown>)[0] = 101n
              return 0
            case 'GetTokenInformation':
              if (args[2] == null) {
                ;(args[4] as number[])[0] = tokenData.length
                return false
              }
              if (returnOutOfRangeTokenSid) {
                const outOfRangePointer = koffi.address(currentSidData)
                if (process.arch === 'ia32') {
                  ;(args[2] as Buffer).writeUInt32LE(Number(outOfRangePointer), 0)
                } else {
                  ;(args[2] as Buffer).writeBigUInt64LE(outOfRangePointer, 0)
                }
                return true
              }
              writeTokenUserBuffer(args[2] as Buffer, currentSidData)
              return true
            case 'GetLengthSid':
              getLengthSidArguments.push(args[0])
              return currentSidData.length
            case 'IsValidSid':
              return true
            case 'EqualSid':
              equalSidCurrentArguments.push(args[1])
              return (
                (args[0] === currentSidPointer ||
                  (typeof args[0] === 'object' && args[0] != null)) &&
                typeof args[1] === 'object' &&
                args[1] != null
              )
            case 'GetSecurityDescriptorDacl':
              ;(args[1] as number[])[0] = 1
              ;(args[2] as Array<unknown>)[0] = 102n
              return true
            case 'GetAclInformation':
              if (typeof args[2] !== 'number' || args[2] <= 0 || args[3] !== 2) {
                throw new Error('GetAclInformation size/class is required')
              }
              ;(args[1] as Record<string, unknown>).AceCount = 1
              return true
            case 'GetAce':
              ;(args[2] as Array<unknown>)[0] = acePointer
              return true
            case 'OpenProcessToken':
              ;(args[2] as Array<unknown>)[0] = 105n
              return true
            case 'LocalFree':
              return failLocalFree && args[0] === 107n ? 106n : null
            case 'ConvertStringSecurityDescriptorToSecurityDescriptorW':
              ;(args[2] as Array<unknown>)[0] = 107n
              return true
            case 'ReadFile':
              if (args[4] !== null) {
                throw new Error('ReadFile OVERLAPPED must be NULL')
              }
              ;(args[3] as number[])[0] = 0
              return true
            case 'WriteFile':
              if (args[4] !== null) {
                throw new Error('WriteFile OVERLAPPED must be NULL')
              }
              ;(args[3] as number[])[0] = Number(args[2])
              return true
            case 'FlushFileBuffers':
              return true
            case 'SetFileInformationByHandle':
              if (!(args[2] instanceof Buffer) || args[3] !== args[2].byteLength) {
                throw new Error('SetFileInformationByHandle buffer size is required')
              }
              return true
            case 'GetCurrentProcess':
              return 108n
            case 'GetLastError':
              return lastError
            default:
              throw new Error(`Unexpected Win32 function ${library}:${name}`)
          }
        }
      }
    })
    const api = createWindowsSecurityApiForTesting(loader)
    if (handleType == null) {
      throw new Error('CreateFileW HANDLE type was not captured.')
    }
    const handleWidth = process.arch === 'ia32' ? 4 : 8
    const decodeHandle = (bytes: Buffer): bigint | null =>
      koffi.decode(bytes, handleType as TypeObject) as bigint | null
    const normalHandleBytes = Buffer.alloc(handleWidth)
    if (process.arch === 'ia32') {
      normalHandleBytes.writeUInt32LE(103, 0)
    } else {
      normalHandleBytes.writeBigUInt64LE(103n, 0)
    }
    normalHandle = decodeHandle(normalHandleBytes)
    nullHandle = decodeHandle(Buffer.alloc(handleWidth))
    invalidHandle = decodeHandle(Buffer.alloc(handleWidth, 0xff))
    expect(normalHandle).toBe(103n)
    expect(nullHandle).toBeNull()
    expect(typeof invalidHandle).toBe('bigint')
    const native = createWindowsSecurityNative({ api })

    expect(native.inspect(String.raw`C:\Users\Alice\LdbProfile`, 'directory')).toBe('trusted')
    const readHandle = native.openRead(String.raw`C:\Users\Alice\LdbProfile\credential.v1`)
    native.readFile(readHandle, Buffer.alloc(1), 1)
    native.writeFile(readHandle, Buffer.from([1]))
    native.flushFileBuffers(readHandle)
    native.renameFile(readHandle, String.raw`C:\Users\Alice\LdbProfile\credential.v1`)
    expect(native.closeHandle(readHandle)).toBe(true)
    const exclusiveHandle = native.createExclusive(
      String.raw`C:\Users\Alice\LdbProfile\.credential.v1.test.tmp`
    )
    expect(native.closeHandle(exclusiveHandle)).toBe(true)

    expect(arities.get('CreateFileW')?.every((arity) => arity === 7)).toBe(true)
    expect(arities.get('GetFileInformationByHandleEx')?.every((arity) => arity === 4)).toBe(true)
    expect(arities.get('GetAclInformation')?.every((arity) => arity === 4)).toBe(true)
    expect(arities.get('ReadFile')?.every((arity) => arity === 5)).toBe(true)
    expect(arities.get('WriteFile')?.every((arity) => arity === 5)).toBe(true)
    expect(arities.get('SetFileInformationByHandle')?.every((arity) => arity === 4)).toBe(true)
    expect(equalSidCurrentArguments.length).toBeGreaterThan(0)
    expect(
      equalSidCurrentArguments.every((value) => typeof value === 'object' && value != null)
    ).toBe(true)
    expect(getLengthSidArguments.length).toBeGreaterThan(0)
    expect(getLengthSidArguments.every((value) => typeof value === 'object' && value != null)).toBe(
      true
    )

    const getLengthSidCallsBeforeOutOfRange = getLengthSidArguments.length
    returnOutOfRangeTokenSid = true
    expect(native.inspect(String.raw`C:\Users\Alice\LdbProfile`, 'directory')).toBe('unavailable')
    expect(getLengthSidArguments.length).toBe(getLengthSidCallsBeforeOutOfRange)
    returnOutOfRangeTokenSid = false

    handleMode = 'null'
    lastError = 2
    expect(native.inspect(String.raw`C:\Users\Alice\LdbProfile\missing`, 'directory')).toBe(
      'missing'
    )

    const fileInfoCallsBeforeInvalidHandle =
      arities.get('GetFileInformationByHandleEx')?.length ?? 0
    const securityInfoCallsBeforeInvalidHandle = arities.get('GetSecurityInfo')?.length ?? 0
    const closeCallsBeforeInvalidHandle = closeCount
    handleMode = 'invalid'
    lastError = 5
    expect(native.inspect(String.raw`C:\Users\Alice\LdbProfile\denied`, 'directory')).toBe(
      'untrusted'
    )
    expect(arities.get('GetFileInformationByHandleEx')?.length ?? 0).toBe(
      fileInfoCallsBeforeInvalidHandle
    )
    expect(arities.get('GetSecurityInfo')?.length ?? 0).toBe(securityInfoCallsBeforeInvalidHandle)
    expect(closeCount).toBe(closeCallsBeforeInvalidHandle)
    const fileInfoCallsBeforeInvalidOpen = arities.get('GetFileInformationByHandleEx')?.length ?? 0
    const securityInfoCallsBeforeInvalidOpen = arities.get('GetSecurityInfo')?.length ?? 0
    const closeCallsBeforeInvalidOpen = closeCount
    expect(() => native.openRead(String.raw`C:\Users\Alice\LdbProfile\invalid`)).toThrow()
    expect(arities.get('GetFileInformationByHandleEx')?.length ?? 0).toBe(
      fileInfoCallsBeforeInvalidOpen
    )
    expect(arities.get('GetSecurityInfo')?.length ?? 0).toBe(securityInfoCallsBeforeInvalidOpen)
    expect(closeCount).toBe(closeCallsBeforeInvalidOpen)
    handleMode = 'normal'
    lastError = ERROR_INSUFFICIENT_BUFFER
    const closeCallsBeforeLocalFreeFailure = closeCount
    const createdHandleCloseCallsBeforeLocalFreeFailure = createdHandleCloseCount
    failLocalFree = true
    expect(() =>
      native.createExclusive(String.raw`C:\Users\Alice\LdbProfile\cleanup.tmp`)
    ).toThrow()
    expect(closeCount).toBe(closeCallsBeforeLocalFreeFailure + 3)
    expect(createdHandleCloseCount).toBe(createdHandleCloseCallsBeforeLocalFreeFailure + 1)
  })

  it.each([
    ['null DACL', { daclPresent: 0 }],
    ['empty DACL', { aceCount: 0 }],
    ['foreign owner', { ownerIsCurrent: false }],
    ['foreign ACE SID', { aceIsCurrent: false }],
    ['broad foreign ACE', { aceIsCurrent: false, accessMask: 0x00010000 }],
    ['object or callback ACE', { aceType: 5 }],
    ['unsupported ACE flags', { aceFlags: 0x80 }]
  ] as const)('rejects %s without substituting names or groups', (_name, options) => {
    const fixture = createSecurityFixture()
    fixture.set(options)
    const native = createWindowsSecurityNative({ api: fixture.api })

    expect(native.inspect(String.raw`C:\Users\Alice\LdbProfile`, 'directory')).toBe('untrusted')
  })

  it('accepts only a current-SID full-control ACL on a non-reparse directory', () => {
    const fixture = createSecurityFixture()
    const native = createWindowsSecurityNative({ api: fixture.api })

    expect(native.inspect(String.raw`C:\Users\Alice\LdbProfile`, 'directory')).toBe('trusted')

    fixture.set({ attributes: FILE_ATTRIBUTE_REPARSE_POINT })
    expect(native.inspect(String.raw`C:\Users\Alice\LdbProfile`, 'directory')).toBe('reparse')

    fixture.set({ attributes: 0 })
    expect(native.inspect(String.raw`C:\Users\Alice\LdbProfile`, 'directory')).toBe('untrusted')

    fixture.set({ attributes: FILE_ATTRIBUTE_DIRECTORY })
    expect(native.inspect(String.raw`C:\Users\Alice\LdbProfile`, 'file')).toBe('untrusted')
  })

  it('does not trust an ancestor ACL owned by a foreign SID', () => {
    const fixture = createSecurityFixture()
    fixture.set({ ownerIsCurrent: false })
    const native = createWindowsSecurityNative({ api: fixture.api })

    expect(native.inspect(String.raw`C:\Users\Alice\LdbProfile`, 'directory', 'ancestor')).toBe(
      'untrusted'
    )
  })
})
