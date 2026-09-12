import { isAbsolute } from 'node:path'
import type { SafeStorage } from 'electron'
import type { CredentialStore } from '../types'
import type { CredentialContext } from './credential-record'
import { createCredentialStore, createUnavailableCredentialStore } from './credential-store'
import { MacOsCredentialFiles } from './macos-credential-files'
import type { CredentialFiles } from './macos-credential-files'

type StoreOptions = Readonly<{
  userDataPath: string
  context: CredentialContext
  safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>
  files?: CredentialFiles
  platform?: NodeJS.Platform
}>
// Main의 단일 coordinator가 이 instance와 writer를 소유한다. Generation/HTTP/복구 종료는 port 호출자가 결정한다.
export function createMacOsCredentialStore(options: StoreOptions): CredentialStore {
  const isMacOs = (options.platform ?? process.platform) === 'darwin'
  if (!isMacOs) {
    return createUnavailableCredentialStore()
  }
  const hasAbsolutePath = isAbsolute(options.userDataPath)
  if (!hasAbsolutePath) {
    throw new Error('Credential storage requires a trusted absolute path.')
  }
  const context = options.context
  const files = new MacOsCredentialFiles(options.userDataPath, context.environment, options.files)
  return createCredentialStore({
    userDataPath: options.userDataPath,
    context,
    safeStorage: options.safeStorage,
    files
  })
}
