import { createWindowsSecurityNative } from './windows-security-native'

export type WindowsProfilePathInspection =
  'missing' | 'trusted' | 'reparse' | 'untrusted' | 'unavailable'

export type WindowsProfileSecurity = Readonly<{
  capabilities: Readonly<{
    profileProtection: 'confirmed' | 'unknown' | 'unavailable'
    namespaceMutation: 'confirmed' | 'unknown' | 'unavailable'
  }>
  inspectDirectory(path: string, role: 'root' | 'ancestor' | 'final'): WindowsProfilePathInspection
  createDirectory(path: string): 'created' | 'already-exists'
  syncDirectory(path: string, role?: 'ancestor' | 'final'): void
}>

export function createWindowsProfileSecurity(): WindowsProfileSecurity {
  const native = createWindowsSecurityNative()
  return {
    capabilities: {
      // The implementation is fail-closed until a supported Windows OS/CPU and
      // power-loss/ACL evidence are recorded for the release target.
      profileProtection: 'unknown',
      namespaceMutation: 'unknown'
    },
    inspectDirectory: (path, role) =>
      native.inspect(path, 'directory', role === 'final' ? 'private' : 'ancestor'),
    createDirectory: (path) => native.createDirectory(path),
    syncDirectory: (path, role = 'final') =>
      native.syncDirectory(path, role === 'final' ? 'private' : 'ancestor')
  }
}
