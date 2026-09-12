import koffi from 'koffi'

export type WindowsNativeHandle = bigint
type WindowsNativePointer = WindowsNativeHandle | ReturnType<typeof koffi.as>
type WindowsSidStorage = Buffer

export type WindowsNativePathInspection =
  'missing' | 'trusted' | 'reparse' | 'untrusted' | 'unavailable'

type WindowsNativePathKind = 'directory' | 'file'
export type WindowsSecurityPolicy = 'private' | 'ancestor'

type WindowsSecurityAttributes = Readonly<{
  value: Record<string, unknown>
  descriptor: WindowsNativeHandle
}>

export type WindowsSecurityNative = Readonly<{
  inspect(
    path: string,
    kind: WindowsNativePathKind,
    policy?: WindowsSecurityPolicy
  ): WindowsNativePathInspection
  createDirectory(path: string): 'created' | 'already-exists'
  list(path: string): string[]
  openRead(path: string): WindowsNativeHandle
  createExclusive(path: string): WindowsNativeHandle
  remove(path: string): void
  syncDirectory(path: string, policy?: WindowsSecurityPolicy): void
  closeHandle(handle: WindowsNativeHandle): boolean
  readFile(handle: WindowsNativeHandle, buffer: Buffer, maximumBytes: number): number
  writeFile(handle: WindowsNativeHandle, data: Buffer): void
  flushFileBuffers(handle: WindowsNativeHandle): void
  renameFile(handle: WindowsNativeHandle, destination: string): void
}>

export type WindowsSecurityNativeOptions = Readonly<{
  api?: WindowsSecurityApi
}>

const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5
const ERROR_INVALID_NAME = 123
const ERROR_ALREADY_EXISTS = 183
const ERROR_FILE_EXISTS = 80
const ERROR_INSUFFICIENT_BUFFER = 122
const ERROR_SUCCESS = 0
const ERROR_NO_MORE_FILES = 18
const FILE_LIST_DIRECTORY = 0x00000001
const FILE_FULL_DIRECTORY_INFO_CLASS = 14
const FILE_FULL_DIRECTORY_RESTART_INFO_CLASS = 15
const DIRECTORY_BUFFER_BYTES = 64 * 1024
const DIRECTORY_ENTRY_HEADER_BYTES = 68
const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const READ_CONTROL = 0x00020000
const DELETE = 0x00010000
const FILE_READ_ATTRIBUTES = 0x00000080
const FILE_SHARE_READ = 0x00000001
const FILE_SHARE_WRITE = 0x00000002
const FILE_SHARE_DELETE = 0x00000004
const OPEN_EXISTING = 3
const CREATE_NEW = 1
const FILE_ATTRIBUTE_NORMAL = 0x00000080
const FILE_ATTRIBUTE_DIRECTORY = 0x00000010
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
const FILE_FLAG_WRITE_THROUGH = 0x80000000
const FILE_ATTRIBUTE_TAG_INFO_CLASS = 9
const FILE_RENAME_INFO_CLASS = 3
const FILE_DISPOSITION_INFO_CLASS = 4
const TOKEN_QUERY = 0x0008
const TOKEN_USER_CLASS = 1
const SE_FILE_OBJECT = 1
const OWNER_SECURITY_INFORMATION = 0x00000001
const DACL_SECURITY_INFORMATION = 0x00000004
const ACCESS_ALLOWED_ACE_TYPE = 0
const ACCESS_DENIED_ACE_TYPE = 1
const KNOWN_ACE_FLAGS = 0x1f
const FILE_DELETE_CHILD = 0x00000040
const WRITE_DAC = 0x00040000
const WRITE_OWNER = 0x00080000
const FILE_ALL_ACCESS = 0x001f01ff
const GENERIC_ALL = 0x10000000
const DANGEROUS_ANCESTOR_MASK =
  DELETE | FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER | GENERIC_WRITE | GENERIC_ALL
const SDDL_REVISION_1 = 1
const MAX_SID_SIZE = 68
const MAX_ACL_SIZE = 64 * 1024

function invalidHandleValue(): WindowsNativeHandle {
  return process.arch === 'ia32' ? 0xffffffffn : 0xffffffffffffffffn
}

const HANDLE = koffi.pointer(koffi.opaque())
const SID = koffi.pointer(koffi.opaque())
const ACL = koffi.pointer(koffi.opaque())
const SECURITY_DESCRIPTOR = koffi.pointer(koffi.opaque())
const SECURITY_ATTRIBUTES = koffi.struct({
  nLength: 'uint32_t',
  lpSecurityDescriptor: SECURITY_DESCRIPTOR,
  bInheritHandle: 'int32_t'
})
const FILE_ATTRIBUTE_TAG_INFO = koffi.struct({
  FileAttributes: 'uint32_t',
  ReparseTag: 'uint32_t'
})
const ACL_SIZE_INFORMATION = koffi.struct({
  AceCount: 'uint32_t',
  AclBytesInUse: 'uint32_t',
  AclBytesFree: 'uint32_t'
})
const GET_ACE_OUTPUT_POINTER = koffi.pointer(koffi.opaque(), 2)

export type WindowsSecurityApi = Readonly<{
  closeHandle(handle: WindowsNativeHandle): boolean
  createDirectory(path: string, attributes: Record<string, unknown>): boolean
  createFile(
    path: string,
    access: number,
    shareMode: number,
    attributes: Record<string, unknown> | null,
    creationDisposition: number,
    flags: number,
    template: null
  ): WindowsNativeHandle | null
  flushFileBuffers(handle: WindowsNativeHandle): boolean
  getFileInformationByHandleEx(
    handle: WindowsNativeHandle,
    informationClass: number,
    information: Record<string, unknown>,
    informationSize: number
  ): boolean
  getDirectoryEntries(
    handle: WindowsNativeHandle,
    informationClass: number,
    buffer: Buffer,
    bufferSize: number
  ): boolean
  getCurrentProcess(): WindowsNativeHandle
  getLastError(): number
  getLengthSid(sid: WindowsNativePointer): number
  getSecurityDescriptorDacl(
    descriptor: WindowsNativeHandle,
    present: number[],
    dacl: Array<WindowsNativeHandle | null>,
    defaulted: number[]
  ): boolean
  getSecurityInfo(
    handle: WindowsNativeHandle,
    objectType: number,
    securityInformation: number,
    owner: Array<WindowsNativePointer | null>,
    group: Array<WindowsNativePointer | null>,
    dacl: Array<WindowsNativeHandle | null>,
    sacl: Array<WindowsNativeHandle | null>,
    descriptor: Array<WindowsNativeHandle | null>
  ): number
  getTokenInformation(
    token: WindowsNativeHandle,
    informationClass: number,
    data: Buffer | null,
    dataLength: number,
    returnLength: number[]
  ): boolean
  getAclInformation(
    dacl: WindowsNativeHandle,
    information: Record<string, unknown>,
    informationSize: number,
    informationClass: number
  ): boolean
  getAce(dacl: WindowsNativeHandle, index: number, ace: Array<WindowsNativeHandle | null>): boolean
  isValidSid(sid: WindowsNativePointer): boolean
  equalSid(left: WindowsNativePointer, right: WindowsNativePointer): boolean
  localFree(memory: WindowsNativeHandle): WindowsNativeHandle | null
  openProcessToken(
    processHandle: WindowsNativeHandle,
    desiredAccess: number,
    token: Array<WindowsNativeHandle | null>
  ): boolean
  convertStringSecurityDescriptorToSecurityDescriptor(
    descriptor: string,
    revision: number,
    securityDescriptor: Array<WindowsNativeHandle | null>,
    descriptorSize: number[]
  ): boolean
  readFile(
    handle: WindowsNativeHandle,
    buffer: Buffer,
    bytesToRead: number,
    bytesRead: number[],
    overlapped: null
  ): boolean
  writeFile(
    handle: WindowsNativeHandle,
    buffer: Buffer,
    bytesToWrite: number,
    bytesWritten: number[],
    overlapped: null
  ): boolean
  setFileInformationByHandle(
    handle: WindowsNativeHandle,
    informationClass: number,
    information: Buffer,
    informationSize: number
  ): boolean
}>

type WindowsApi = WindowsSecurityApi

type WindowsLibrary = Readonly<{
  func(...args: unknown[]): unknown
}>

type WindowsLibraryLoader = (libraryName: string) => WindowsLibrary

function bindWindowsApi(loadLibrary: WindowsLibraryLoader): WindowsApi {
  const kernel32 = loadLibrary('kernel32.dll')
  const advapi32 = loadLibrary('advapi32.dll')
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', [
    HANDLE
  ]) as WindowsApi['closeHandle']
  const createDirectory = kernel32.func('__stdcall', 'CreateDirectoryW', 'bool', [
    'str16',
    koffi.pointer(SECURITY_ATTRIBUTES)
  ]) as WindowsApi['createDirectory']
  const createFile = kernel32.func('__stdcall', 'CreateFileW', HANDLE, [
    'str16',
    'uint32_t',
    'uint32_t',
    koffi.pointer(SECURITY_ATTRIBUTES),
    'uint32_t',
    'uint32_t',
    HANDLE
  ]) as WindowsApi['createFile']
  const flushFileBuffers = kernel32.func('__stdcall', 'FlushFileBuffers', 'bool', [
    HANDLE
  ]) as WindowsApi['flushFileBuffers']
  const getFileInformationByHandleEx = kernel32.func(
    '__stdcall',
    'GetFileInformationByHandleEx',
    'bool',
    [HANDLE, 'uint32_t', koffi.out(koffi.pointer(FILE_ATTRIBUTE_TAG_INFO)), 'uint32_t']
  ) as WindowsApi['getFileInformationByHandleEx']
  const getDirectoryEntries = kernel32.func(
    '__stdcall',
    'GetFileInformationByHandleEx',
    'int32_t',
    [HANDLE, 'uint32_t', koffi.out(koffi.pointer('uint8_t')), 'uint32_t']
  ) as WindowsApi['getDirectoryEntries']
  const getCurrentProcess = kernel32.func(
    '__stdcall',
    'GetCurrentProcess',
    HANDLE,
    []
  ) as WindowsApi['getCurrentProcess']
  const getLastError = kernel32.func(
    '__stdcall',
    'GetLastError',
    'uint32_t',
    []
  ) as WindowsApi['getLastError']
  const getLengthSid = advapi32.func('__stdcall', 'GetLengthSid', 'uint32_t', [
    SID
  ]) as WindowsApi['getLengthSid']
  const getSecurityInfo = advapi32.func('__stdcall', 'GetSecurityInfo', 'uint32_t', [
    HANDLE,
    'uint32_t',
    'uint32_t',
    koffi.out(koffi.pointer(SID)),
    koffi.out(koffi.pointer(SID)),
    koffi.out(koffi.pointer(ACL)),
    koffi.out(koffi.pointer(ACL)),
    koffi.out(koffi.pointer(SECURITY_DESCRIPTOR))
  ]) as WindowsApi['getSecurityInfo']
  const getSecurityDescriptorDacl = advapi32.func(
    '__stdcall',
    'GetSecurityDescriptorDacl',
    'bool',
    [
      SECURITY_DESCRIPTOR,
      koffi.out(koffi.pointer('int32_t')),
      koffi.out(koffi.pointer(ACL)),
      koffi.out(koffi.pointer('int32_t'))
    ]
  ) as WindowsApi['getSecurityDescriptorDacl']
  const getTokenInformation = advapi32.func('__stdcall', 'GetTokenInformation', 'bool', [
    HANDLE,
    'uint32_t',
    'void *',
    'uint32_t',
    koffi.out(koffi.pointer('uint32_t'))
  ]) as WindowsApi['getTokenInformation']
  const getAclInformation = advapi32.func('__stdcall', 'GetAclInformation', 'bool', [
    ACL,
    koffi.out(koffi.pointer(ACL_SIZE_INFORMATION)),
    'uint32_t',
    'uint32_t'
  ]) as WindowsApi['getAclInformation']
  const getAce = advapi32.func('__stdcall', 'GetAce', 'bool', [
    ACL,
    'uint32_t',
    koffi.out(GET_ACE_OUTPUT_POINTER)
  ]) as WindowsApi['getAce']
  const isValidSid = advapi32.func('__stdcall', 'IsValidSid', 'bool', [
    SID
  ]) as WindowsApi['isValidSid']
  const equalSid = advapi32.func('__stdcall', 'EqualSid', 'bool', [
    SID,
    SID
  ]) as WindowsApi['equalSid']
  const localFree = kernel32.func('__stdcall', 'LocalFree', HANDLE, [
    HANDLE
  ]) as WindowsApi['localFree']
  const openProcessToken = advapi32.func('__stdcall', 'OpenProcessToken', 'bool', [
    HANDLE,
    'uint32_t',
    koffi.out(koffi.pointer(HANDLE))
  ]) as WindowsApi['openProcessToken']
  const convertStringSecurityDescriptorToSecurityDescriptor = advapi32.func(
    '__stdcall',
    'ConvertStringSecurityDescriptorToSecurityDescriptorW',
    'bool',
    [
      'str16',
      'uint32_t',
      koffi.out(koffi.pointer(SECURITY_DESCRIPTOR)),
      koffi.out(koffi.pointer('uint32_t'))
    ]
  ) as WindowsApi['convertStringSecurityDescriptorToSecurityDescriptor']
  const readFile = kernel32.func('__stdcall', 'ReadFile', 'bool', [
    HANDLE,
    'void *',
    'uint32_t',
    koffi.out(koffi.pointer('uint32_t')),
    'void *'
  ]) as WindowsApi['readFile']
  const writeFile = kernel32.func('__stdcall', 'WriteFile', 'bool', [
    HANDLE,
    'void *',
    'uint32_t',
    koffi.out(koffi.pointer('uint32_t')),
    'void *'
  ]) as WindowsApi['writeFile']
  const setFileInformationByHandle = kernel32.func(
    '__stdcall',
    'SetFileInformationByHandle',
    'bool',
    [HANDLE, 'uint32_t', 'void *', 'uint32_t']
  ) as WindowsApi['setFileInformationByHandle']

  return {
    closeHandle,
    createDirectory,
    createFile,
    flushFileBuffers,
    getFileInformationByHandleEx,
    getDirectoryEntries,
    getCurrentProcess,
    getLastError,
    getLengthSid,
    getSecurityDescriptorDacl,
    getSecurityInfo,
    getTokenInformation,
    getAclInformation,
    getAce,
    isValidSid,
    equalSid,
    localFree,
    openProcessToken,
    convertStringSecurityDescriptorToSecurityDescriptor,
    readFile,
    writeFile,
    setFileInformationByHandle
  }
}

function createWindowsApi(): WindowsApi {
  if (process.platform !== 'win32') {
    throw new Error('Windows native API is unavailable on this platform.')
  }
  return bindWindowsApi((libraryName) => koffi.load(libraryName))
}

export function createWindowsSecurityApiForTesting(
  loadLibrary: WindowsLibraryLoader
): WindowsSecurityApi {
  return bindWindowsApi(loadLibrary)
}

export function getWindowsSecurityBindingContractForTesting(): Readonly<{
  getAceOutputTypeName: string
}> {
  return { getAceOutputTypeName: GET_ACE_OUTPUT_POINTER.name }
}

function getApi(): WindowsApi {
  return createWindowsApi()
}

function isInvalidHandle(handle: WindowsNativeHandle | null): handle is null {
  return handle == null || handle === invalidHandleValue()
}

function nativeError(api: WindowsApi): Error {
  return new Error(`Windows native operation failed (${api.getLastError()}).`)
}

function classifyPathError(errorCode: number): WindowsNativePathInspection {
  if (
    errorCode === ERROR_FILE_NOT_FOUND ||
    errorCode === ERROR_PATH_NOT_FOUND ||
    errorCode === ERROR_INVALID_NAME
  ) {
    return 'missing'
  }
  if (errorCode === ERROR_ACCESS_DENIED) {
    return 'untrusted'
  }
  return 'unavailable'
}

function readPointer(data: Buffer): WindowsNativeHandle {
  return process.arch === 'ia32' ? BigInt(data.readUInt32LE(0)) : data.readBigUInt64LE(0)
}

function sidPointer(storage: WindowsSidStorage): ReturnType<typeof koffi.as> {
  return koffi.as(storage, SID) as ReturnType<typeof koffi.as>
}

function getTokenSidStorage(
  tokenData: Buffer,
  tokenSidAddress: WindowsNativeHandle
): WindowsSidStorage | null {
  const tokenDataStart = koffi.address(tokenData)
  const tokenDataEnd = tokenDataStart + BigInt(tokenData.byteLength)
  if (tokenSidAddress < tokenDataStart || tokenSidAddress >= tokenDataEnd) {
    return null
  }
  const offset = tokenSidAddress - tokenDataStart
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null
  }
  return tokenData.subarray(Number(offset))
}

function sidString(data: Buffer): string | null {
  if (data.length < 8 || data[0] !== 1) {
    return null
  }
  const subAuthorityCount = data[1]
  const expectedLength = 8 + subAuthorityCount * 4
  if (subAuthorityCount > 15 || data.length !== expectedLength) {
    return null
  }
  let identifierAuthority = 0n
  for (const byte of data.subarray(2, 8)) {
    identifierAuthority = (identifierAuthority << 8n) | BigInt(byte)
  }
  const subAuthorities = Array.from({ length: subAuthorityCount }, (_, index) =>
    data.readUInt32LE(8 + index * 4)
  )
  return [`S-${data[0]}-${identifierAuthority}`, ...subAuthorities].join('-')
}

function currentUserSid(api: WindowsApi): {
  storage: WindowsSidStorage
  sddl: string
} {
  const token = [null] as Array<WindowsNativeHandle | null>
  const processHandle = api.getCurrentProcess()
  if (!api.openProcessToken(processHandle, TOKEN_QUERY, token) || token[0] == null) {
    throw nativeError(api)
  }
  let result: { storage: WindowsSidStorage; sddl: string } | null = null
  let closeFailed = false
  try {
    const requiredLength = [0]
    api.getTokenInformation(token[0], TOKEN_USER_CLASS, null, 0, requiredLength)
    const isExpectedSizingFailure =
      requiredLength[0] > 0 && api.getLastError() === ERROR_INSUFFICIENT_BUFFER
    if (!isExpectedSizingFailure) {
      throw nativeError(api)
    }
    const tokenData = Buffer.alloc(requiredLength[0])
    if (!api.getTokenInformation(token[0], TOKEN_USER_CLASS, tokenData, tokenData.length, [0])) {
      throw nativeError(api)
    }
    const tokenSidAddress = readPointer(tokenData)
    const tokenSidView = getTokenSidStorage(tokenData, tokenSidAddress)
    if (tokenSidView == null) {
      throw new Error('Current Windows token SID is outside the token buffer.')
    }
    const tokenSidPointer = sidPointer(tokenSidView)
    const sidLength = api.getLengthSid(tokenSidPointer)
    if (
      !Number.isSafeInteger(sidLength) ||
      sidLength < 8 ||
      sidLength > MAX_SID_SIZE ||
      sidLength > tokenSidView.byteLength ||
      !api.isValidSid(tokenSidPointer)
    ) {
      throw new Error('Current Windows token SID is invalid.')
    }
    const storage = Buffer.from(tokenSidView.subarray(0, sidLength))
    const ownedSid = sidPointer(storage)
    if (!api.isValidSid(ownedSid)) {
      throw new Error('Copied Windows token SID is invalid.')
    }
    const stringSid = sidString(storage)
    if (stringSid == null) {
      throw new Error('Current Windows token SID could not be encoded.')
    }
    // Keep the copied SID Buffer alive and cast it at each EqualSid call. The
    // TOKEN_USER output buffer is not retained as the ownership boundary.
    result = { storage, sddl: stringSid }
  } finally {
    closeFailed = !api.closeHandle(token[0])
  }
  if (closeFailed) {
    throw nativeError(api)
  }
  if (result == null) {
    throw new Error('Current Windows token SID is unavailable.')
  }
  return result
}

function isSecureDacl(
  api: WindowsApi,
  descriptor: WindowsNativeHandle,
  owner: WindowsNativePointer | null,
  currentSid: WindowsSidStorage,
  policy: WindowsSecurityPolicy
): boolean {
  if (owner == null || !api.isValidSid(owner) || !api.equalSid(owner, sidPointer(currentSid))) {
    return false
  }
  const present = [0]
  const dacl = [null] as Array<WindowsNativeHandle | null>
  const defaulted = [0]
  if (!api.getSecurityDescriptorDacl(descriptor, present, dacl, defaulted)) {
    throw new Error('Windows DACL could not be inspected.')
  }
  // A non-present or null DACL means unrestricted access. An empty DACL is distinct,
  // but it cannot grant the current user the access needed by the profile.
  if (present[0] === 0 || dacl[0] == null) {
    return false
  }
  const aclInformation: Record<string, unknown> = {}
  if (!api.getAclInformation(dacl[0], aclInformation, koffi.sizeof(ACL_SIZE_INFORMATION), 2)) {
    throw new Error('Windows ACL information could not be inspected.')
  }
  const aceCount = aclInformation.AceCount
  if (typeof aceCount !== 'number' || aceCount < 1 || aceCount > 4096) {
    return false
  }
  for (let index = 0; index < aceCount; index += 1) {
    const ace = [null] as Array<WindowsNativeHandle | null>
    if (!api.getAce(dacl[0], index, ace) || ace[0] == null) {
      throw new Error('Windows ACL entry could not be inspected.')
    }
    const aceHeader = Buffer.from(koffi.decode(ace[0], 'uint8_t', 8))
    const aceType = aceHeader[0]
    const aceFlags = aceHeader[1]
    const aceSize = aceHeader.readUInt16LE(2)
    const accessMask = aceHeader.readUInt32LE(4)
    const hasSupportedType =
      aceType === ACCESS_ALLOWED_ACE_TYPE || aceType === ACCESS_DENIED_ACE_TYPE
    const hasSupportedFlags =
      policy === 'private' ? aceFlags === 0 : (aceFlags & ~KNOWN_ACE_FLAGS) === 0
    if (!hasSupportedType || !hasSupportedFlags || aceSize < 12 || aceSize > MAX_ACL_SIZE) {
      return false
    }
    const aceMemory = Buffer.from(koffi.decode(ace[0], 'uint8_t', aceSize))
    const aceSid = koffi.as(aceMemory.subarray(8), SID) as ReturnType<typeof koffi.as>
    if (!api.isValidSid(aceSid)) {
      return false
    }
    const aceSidLength = api.getLengthSid(aceSid)
    if (aceSidLength <= 0 || aceSize !== 8 + aceSidLength) {
      return false
    }
    const isCurrentSid = api.equalSid(aceSid, sidPointer(currentSid))
    if (policy === 'private') {
      if (
        aceCount !== 1 ||
        aceType !== ACCESS_ALLOWED_ACE_TYPE ||
        !isCurrentSid ||
        (accessMask !== FILE_ALL_ACCESS && accessMask !== GENERIC_ALL)
      ) {
        return false
      }
      continue
    }
    if (!isCurrentSid && aceType === ACCESS_ALLOWED_ACE_TYPE) {
      const grantsDangerousAccess = (accessMask & DANGEROUS_ANCESTOR_MASK) !== 0
      if (grantsDangerousAccess) {
        return false
      }
    }
  }
  return true
}

function inspectHandle(
  api: WindowsApi,
  handle: WindowsNativeHandle,
  kind: WindowsNativePathKind,
  policy: WindowsSecurityPolicy
): WindowsNativePathInspection {
  const fileInformation: Record<string, unknown> = {}
  if (
    !api.getFileInformationByHandleEx(
      handle,
      FILE_ATTRIBUTE_TAG_INFO_CLASS,
      fileInformation,
      koffi.sizeof(FILE_ATTRIBUTE_TAG_INFO)
    )
  ) {
    return 'unavailable'
  }
  const attributes = fileInformation.FileAttributes
  if (typeof attributes !== 'number') {
    return 'unavailable'
  }
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
    return 'reparse'
  }
  const isDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0
  if (isDirectory !== (kind === 'directory')) {
    return 'untrusted'
  }
  const owner = [null] as Array<WindowsNativePointer | null>
  const group = [null] as Array<WindowsNativeHandle | null>
  const dacl = [null] as Array<WindowsNativeHandle | null>
  const sacl = [null] as Array<WindowsNativeHandle | null>
  const descriptor = [null] as Array<WindowsNativeHandle | null>
  const securityResult = api.getSecurityInfo(
    handle,
    SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    owner,
    group,
    dacl,
    sacl,
    descriptor
  )
  if (securityResult !== ERROR_SUCCESS || descriptor[0] == null) {
    return 'unavailable'
  }
  let inspection: WindowsNativePathInspection = 'unavailable'
  let releaseFailed = false
  try {
    const currentSid = currentUserSid(api)
    inspection = isSecureDacl(api, descriptor[0], owner[0], currentSid.storage, policy)
      ? 'trusted'
      : 'untrusted'
  } finally {
    releaseFailed = api.localFree(descriptor[0]) != null
  }
  if (releaseFailed) {
    throw new Error('Windows security descriptor could not be released.')
  }
  return inspection
}

function inspectPath(
  api: WindowsApi,
  path: string,
  kind: WindowsNativePathKind,
  policy: WindowsSecurityPolicy
): WindowsNativePathInspection {
  const access = FILE_READ_ATTRIBUTES | READ_CONTROL
  const flags =
    FILE_FLAG_OPEN_REPARSE_POINT | (kind === 'directory' ? FILE_FLAG_BACKUP_SEMANTICS : 0)
  const handle = api.createFile(
    path,
    access,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    null,
    OPEN_EXISTING,
    flags,
    null
  )
  if (isInvalidHandle(handle)) {
    return classifyPathError(api.getLastError())
  }
  let inspection: WindowsNativePathInspection = 'unavailable'
  try {
    inspection = inspectHandle(api, handle, kind, policy)
  } catch {
    inspection = 'unavailable'
  }
  if (!api.closeHandle(handle)) {
    return 'unavailable'
  }
  return inspection
}

/*
 * This is kept as a handle-bound check so callers that will read or mutate a
 * file can validate the object they already opened, not only the path that led
 * to it.
 */
function assertTrustedHandle(
  api: WindowsApi,
  handle: WindowsNativeHandle,
  kind: WindowsNativePathKind,
  policy: WindowsSecurityPolicy
): void {
  const inspection = inspectHandle(api, handle, kind, policy)
  if (inspection !== 'trusted') {
    throw new Error('Windows native handle is not trusted.')
  }
}

function privateSecurityAttributes(api: WindowsApi): WindowsSecurityAttributes {
  const sid = currentUserSid(api)
  const descriptor = [null] as Array<WindowsNativeHandle | null>
  const descriptorSize = [0]
  const sddl = `O:${sid.sddl}D:P(A;;FA;;;${sid.sddl})`
  if (
    !api.convertStringSecurityDescriptorToSecurityDescriptor(
      sddl,
      SDDL_REVISION_1,
      descriptor,
      descriptorSize
    ) ||
    descriptor[0] == null
  ) {
    throw nativeError(api)
  }
  return {
    value: {
      nLength: koffi.sizeof(SECURITY_ATTRIBUTES),
      lpSecurityDescriptor: descriptor[0],
      bInheritHandle: 0
    },
    descriptor: descriptor[0]
  }
}

function renameInfo(destination: string): Buffer {
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    throw new Error('Windows credential rename is unavailable on this architecture.')
  }
  const filename = Buffer.from(destination, 'utf16le')
  const information = Buffer.alloc(20 + filename.byteLength)
  information.writeUInt32LE(1, 0)
  information.writeBigUInt64LE(0n, 8)
  information.writeUInt32LE(filename.byteLength, 16)
  filename.copy(information, 20)
  return information
}

function readDirectoryBatch(buffer: Buffer): string[] {
  const names: string[] = []
  const decoder = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true })
  let offset = 0
  while (true) {
    const hasHeader = offset + DIRECTORY_ENTRY_HEADER_BYTES <= buffer.byteLength
    if (!hasHeader) {
      throw new Error('Windows directory entry header is incomplete.')
    }
    const nextOffset = buffer.readUInt32LE(offset)
    const filenameBytes = buffer.readUInt32LE(offset + 60)
    const isEmptyName = filenameBytes === 0
    const isOddLength = filenameBytes % 2 !== 0
    const nameEnd = offset + DIRECTORY_ENTRY_HEADER_BYTES + filenameBytes
    const exceedsBuffer = nameEnd > buffer.byteLength
    const isInvalidLength = isEmptyName || isOddLength || exceedsBuffer
    if (isInvalidLength) {
      throw new Error('Windows directory filename length is invalid.')
    }
    const isLastEntry = nextOffset === 0
    if (!isLastEntry) {
      const isAligned = nextOffset % 8 === 0
      const overlapsName = offset + nextOffset < nameEnd
      const lacksNextHeader = offset + nextOffset + DIRECTORY_ENTRY_HEADER_BYTES > buffer.byteLength
      const isInvalidNext = !isAligned || overlapsName || lacksNextHeader
      if (isInvalidNext) {
        throw new Error('Windows directory entry offset is invalid.')
      }
    }
    const name = decoder.decode(buffer.subarray(offset + DIRECTORY_ENTRY_HEADER_BYTES, nameEnd))
    const isDotEntry = name === '.' || name === '..'
    if (!isDotEntry) {
      const hasNull = name.includes('\0')
      const hasUnsafeCharacter = /[\\/:]/u.test(name)
      const hasAliasedEnding = /[. ]$/u.test(name)
      const isUnsafeName = hasNull || hasUnsafeCharacter || hasAliasedEnding
      if (isUnsafeName) {
        throw new Error('Windows directory filename is unsafe.')
      }
      names.push(name)
    }
    if (isLastEntry) {
      return names
    }
    offset += nextOffset
  }
}

function listDirectory(api: WindowsApi, path: string): string[] {
  const handle = api.createFile(
    path,
    FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    null,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    null
  )
  const isOpenInvalid = isInvalidHandle(handle)
  if (isOpenInvalid) {
    throw nativeError(api)
  }
  const names: string[] = []
  let closeFailed = false
  try {
    assertTrustedHandle(api, handle, 'directory', 'private')
    // FILE_FULL_DIR_INFO requires 8-byte alignment. Koffi passes this Buffer's
    // actual address synchronously; retain its backing storage for every call.
    const storage = Buffer.alloc(DIRECTORY_BUFFER_BYTES + 7)
    const alignmentOffset = Number((8n - (koffi.address(storage) % 8n)) % 8n)
    const buffer = storage.subarray(alignmentOffset, alignmentOffset + DIRECTORY_BUFFER_BYTES)
    let informationClass = FILE_FULL_DIRECTORY_RESTART_INFO_CLASS
    while (true) {
      // The API supplies no byte count. Clear stale records before each call,
      // and reject failed/overflow queries rather than consuming partial data.
      buffer.fill(0)
      const succeeded = api.getDirectoryEntries(handle, informationClass, buffer, buffer.byteLength)
      if (!succeeded) {
        const errorCode = api.getLastError()
        const isEnumerationComplete = errorCode === ERROR_NO_MORE_FILES
        if (isEnumerationComplete) {
          break
        }
        throw new Error(`Windows directory enumeration failed (${errorCode}).`)
      }
      names.push(...readDirectoryBatch(buffer))
      informationClass = FILE_FULL_DIRECTORY_INFO_CLASS
    }
  } finally {
    closeFailed = !api.closeHandle(handle)
  }
  if (closeFailed) {
    throw new Error('Windows directory handle could not be closed.')
  }
  return names
}

export function createWindowsSecurityNative(
  options: WindowsSecurityNativeOptions = {}
): WindowsSecurityNative {
  let api: WindowsApi | null = options.api ?? null
  const nativeApi = (): WindowsApi => {
    api ??= getApi()
    return api
  }
  return {
    inspect: (path, kind, policy = 'private') => inspectPath(nativeApi(), path, kind, policy),
    list: (path) => listDirectory(nativeApi(), path),
    createDirectory: (path) => {
      const currentApi = nativeApi()
      const attributes = privateSecurityAttributes(currentApi)
      let result: 'created' | 'already-exists' | null = null
      let releaseFailed = false
      try {
        const created = currentApi.createDirectory(path, attributes.value)
        if (created) {
          result = 'created'
        } else {
          const errorCode = currentApi.getLastError()
          if (errorCode === ERROR_ALREADY_EXISTS || errorCode === ERROR_FILE_EXISTS) {
            result = 'already-exists'
          } else {
            throw nativeError(currentApi)
          }
        }
      } finally {
        releaseFailed = currentApi.localFree(attributes.descriptor) != null
      }
      if (releaseFailed) {
        throw new Error('Windows security descriptor could not be released.')
      }
      if (result == null) {
        throw new Error('Windows directory creation result is unavailable.')
      }
      return result
    },
    openRead: (path) => {
      const currentApi = nativeApi()
      const handle = currentApi.createFile(
        path,
        GENERIC_READ | FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        null,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
        null
      )
      if (isInvalidHandle(handle)) {
        throw nativeError(currentApi)
      }
      try {
        assertTrustedHandle(currentApi, handle, 'file', 'private')
      } catch (error) {
        currentApi.closeHandle(handle)
        throw error
      }
      return handle
    },
    createExclusive: (path) => {
      const currentApi = nativeApi()
      const attributes = privateSecurityAttributes(currentApi)
      let createdHandle: WindowsNativeHandle | null = null
      let handleIsOpen = false
      let releaseFailed = false
      let result: WindowsNativeHandle | null = null
      try {
        const handle = currentApi.createFile(
          path,
          GENERIC_READ | GENERIC_WRITE | DELETE | READ_CONTROL,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          attributes.value,
          CREATE_NEW,
          FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
          null
        )
        if (isInvalidHandle(handle)) {
          throw nativeError(currentApi)
        }
        createdHandle = handle
        handleIsOpen = true
        try {
          assertTrustedHandle(currentApi, handle, 'file', 'private')
        } catch (error) {
          handleIsOpen = false
          currentApi.closeHandle(handle)
          throw error
        }
        result = handle
      } finally {
        releaseFailed = currentApi.localFree(attributes.descriptor) != null
      }
      if (releaseFailed) {
        if (handleIsOpen && createdHandle != null) {
          currentApi.closeHandle(createdHandle)
        }
        throw new Error('Windows security descriptor could not be released.')
      }
      if (result == null) {
        throw new Error('Windows exclusive file handle is unavailable.')
      }
      return result
    },
    remove: (path) => {
      const currentApi = nativeApi()
      const handle = currentApi.createFile(
        path,
        DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        null,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
        null
      )
      if (isInvalidHandle(handle)) {
        throw nativeError(currentApi)
      }
      let closeFailed = false
      try {
        assertTrustedHandle(currentApi, handle, 'file', 'private')
        const disposition = Buffer.from([1])
        if (
          !currentApi.setFileInformationByHandle(
            handle,
            FILE_DISPOSITION_INFO_CLASS,
            disposition,
            disposition.byteLength
          )
        ) {
          throw nativeError(currentApi)
        }
      } finally {
        closeFailed = !currentApi.closeHandle(handle)
      }
      if (closeFailed) {
        throw nativeError(currentApi)
      }
    },
    syncDirectory: (path, policy = 'private') => {
      const currentApi = nativeApi()
      const handle = currentApi.createFile(
        path,
        GENERIC_READ | FILE_READ_ATTRIBUTES | READ_CONTROL,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        null,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        null
      )
      if (isInvalidHandle(handle)) {
        throw nativeError(currentApi)
      }
      let closeFailed = false
      try {
        assertTrustedHandle(currentApi, handle, 'directory', policy)
        if (!currentApi.flushFileBuffers(handle)) {
          throw nativeError(currentApi)
        }
      } finally {
        closeFailed = !currentApi.closeHandle(handle)
      }
      if (closeFailed) {
        throw nativeError(currentApi)
      }
    },
    closeHandle: (handle) => nativeApi().closeHandle(handle),
    readFile: (handle, buffer, maximumBytes) => {
      const currentApi = nativeApi()
      const bytesRead = [0]
      if (!currentApi.readFile(handle, buffer, maximumBytes, bytesRead, null)) {
        throw nativeError(currentApi)
      }
      return bytesRead[0]
    },
    writeFile: (handle, data) => {
      const currentApi = nativeApi()
      let offset = 0
      while (offset < data.byteLength) {
        const bytesWritten = [0]
        const remaining = data.subarray(offset)
        if (!currentApi.writeFile(handle, remaining, remaining.byteLength, bytesWritten, null)) {
          throw nativeError(currentApi)
        }
        if (bytesWritten[0] <= 0 || bytesWritten[0] > remaining.byteLength) {
          throw new Error('Windows credential write was incomplete.')
        }
        offset += bytesWritten[0]
      }
    },
    flushFileBuffers: (handle) => {
      const currentApi = nativeApi()
      if (!currentApi.flushFileBuffers(handle)) {
        throw nativeError(currentApi)
      }
    },
    renameFile: (handle, destination) => {
      const currentApi = nativeApi()
      const information = renameInfo(destination)
      if (
        !currentApi.setFileInformationByHandle(
          handle,
          FILE_RENAME_INFO_CLASS,
          information,
          information.byteLength
        )
      ) {
        throw nativeError(currentApi)
      }
    }
  }
}
