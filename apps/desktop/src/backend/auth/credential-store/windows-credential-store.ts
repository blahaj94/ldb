import { isAbsolute } from 'node:path/win32'
import type { SafeStorage } from 'electron'
import type { CredentialStore } from '../types'
import { createCredentialStore, createUnavailableCredentialStore } from './credential-store'
import type { CredentialContext } from './credential-record'
import { WindowsCredentialFiles, type WindowsCredentialNative } from './windows-credential-files'
import { createWindowsCredentialNative } from './windows-credential-native'

export type WindowsCredentialStoreOptions = Readonly<{
  userDataPath: string
  context: CredentialContext
  safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>
  native?: WindowsCredentialNative
  platform?: NodeJS.Platform
}>

export function createWindowsCredentialStore(
  options: WindowsCredentialStoreOptions
): CredentialStore {
  const isWindows = (options.platform ?? process.platform) === 'win32'
  if (!isWindows) {
    return createUnavailableCredentialStore()
  }
  if (!isAbsolute(options.userDataPath)) {
    throw new Error('Credential storage requires a trusted absolute path.')
  }
  const native = options.native ?? createWindowsCredentialNative()
  const files = new WindowsCredentialFiles(
    options.userDataPath,
    options.context.environment,
    native
  )
  return createCredentialStore({
    userDataPath: options.userDataPath,
    context: options.context,
    safeStorage: options.safeStorage,
    files
  })
}
