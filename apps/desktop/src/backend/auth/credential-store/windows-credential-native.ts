import type {
  WindowsCredentialFileHandle,
  WindowsCredentialNative,
  WindowsPathInspection
} from './windows-credential-files'
import { createWindowsSecurityNative } from '../windows-security-native'

function mapInspection(
  inspection: ReturnType<ReturnType<typeof createWindowsSecurityNative>['inspect']>,
  kind: 'directory' | 'file'
): WindowsPathInspection {
  switch (inspection) {
    case 'missing':
      return { status: 'missing' }
    case 'reparse':
      return { status: 'reparse' }
    case 'trusted':
      return { status: kind === 'directory' ? 'trusted-directory' : 'trusted-file' }
    case 'untrusted':
      return { status: 'untrusted' }
    case 'unavailable':
      return { status: 'unavailable' }
  }
}

function createHandle(
  native: ReturnType<typeof createWindowsSecurityNative>,
  handle: bigint
): WindowsCredentialFileHandle {
  let isClosed = false
  const close = async (): Promise<void> => {
    if (isClosed) {
      return
    }
    isClosed = true
    if (!native.closeHandle(handle)) {
      throw new Error('Windows credential handle could not be closed.')
    }
  }
  return {
    read: async (maximumBytes) => {
      const buffer = Buffer.alloc(maximumBytes)
      const bytesRead = native.readFile(handle, buffer, maximumBytes)
      return buffer.subarray(0, bytesRead)
    },
    write: async (data) => {
      native.writeFile(handle, data)
    },
    flush: async () => {
      native.flushFileBuffers(handle)
    },
    rename: async (destination) => {
      native.renameFile(handle, destination)
    },
    close
  }
}

export function createWindowsCredentialNative(): WindowsCredentialNative {
  const native = createWindowsSecurityNative()
  return {
    capabilities: {
      // Implementation is present, but release evidence for Windows SID/DACL and
      // namespace durability is still required before enabling the native gate.
      profileProtection: 'unknown',
      fileMutation: 'unknown',
      namespaceMutation: 'unknown'
    },
    inspect: async (path, kind) => mapInspection(native.inspect(path, kind), kind),
    createDirectory: async (path) => native.createDirectory(path),
    list: async () => {
      throw new Error('Windows credential directory enumeration is unavailable.')
    },
    openRead: async (path) => createHandle(native, native.openRead(path)),
    createExclusive: async (path) => createHandle(native, native.createExclusive(path)),
    remove: async (path) => native.remove(path),
    syncDirectory: async (path) => native.syncDirectory(path)
  }
}
