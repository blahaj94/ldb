import * as fs from 'node:fs'
import { isAbsolute, parse } from 'node:path'
import type { Stats } from 'node:fs'
import { validateApiOrigin, validateReturnTarget } from './protocol'
import type { AuthProvider } from './types'

export type AuthRuntimeConfig = Readonly<{
  apiOrigin: string
  returnTarget: string
  environment: string
  providers: readonly AuthProvider[]
  appIdentity: string
  userDataPath: string
}>

export type AuthRuntimeProfileApplication = Readonly<{
  setPath(name: 'userData', path: string): void
  setName(name: string): void
  setAppUserModelId(id: string): void
}>

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>

function isAuthProvider(value: string): value is AuthProvider {
  const isSupported = value === 'google'

  return isSupported
}

function readRequiredText(environment: RuntimeEnvironment, key: string): string | null {
  const value = environment[key]
  const hasValue = value != null
  if (!hasValue || value.length === 0) {
    return null
  }

  return value
}

function readProviders(environment: RuntimeEnvironment): readonly AuthProvider[] | null {
  const rawProviders = readRequiredText(environment, 'LDB_AUTH_PROVIDERS')
  if (rawProviders == null) {
    return null
  }

  const providers = rawProviders.split(',')
  const hasOnlySupportedProviders = providers.every(isAuthProvider)
  const hasProviders = providers.length > 0
  const hasNoDuplicates = new Set(providers).size === providers.length
  const hasValidProviders = hasProviders && hasOnlySupportedProviders && hasNoDuplicates
  if (!hasValidProviders) {
    return null
  }

  return providers
}

function isMissing(error: unknown): boolean {
  const hasError = error != null
  if (!hasError || typeof error !== 'object' || !('code' in error)) {
    return false
  }

  return error.code === 'ENOENT'
}

function assertPrivateUserDataDirectory(stat: Stats): void {
  const isDirectory = stat.isDirectory()
  const isSymlink = stat.isSymbolicLink()
  const uid = process.getuid?.()
  const hasPrivatePosixProtection =
    uid == null || (stat.uid === uid && (stat.mode & 0o7777) === 0o700)
  const isTrustedDirectory = isDirectory && !isSymlink && hasPrivatePosixProtection
  if (!isTrustedDirectory) {
    throw new Error('Trusted userData directory is unavailable.')
  }
}

function prepareUserDataDirectory(path: string): void {
  let stat: Stats
  try {
    stat = fs.lstatSync(path)
  } catch (error) {
    const isMissingPath = isMissing(error)
    if (!isMissingPath) {
      throw error
    }
    fs.mkdirSync(path, { recursive: true, mode: 0o700 })
    stat = fs.lstatSync(path)
  }
  assertPrivateUserDataDirectory(stat)
}

export function readAuthRuntimeConfig(
  environment: RuntimeEnvironment = process.env
): AuthRuntimeConfig | null {
  const apiOrigin = readRequiredText(environment, 'LDB_AUTH_API_ORIGIN')
  const returnTarget = readRequiredText(environment, 'LDB_AUTH_RETURN_TARGET')
  const profile = readRequiredText(environment, 'LDB_AUTH_ENVIRONMENT')
  const providers = readProviders(environment)
  const appIdentity = readRequiredText(environment, 'LDB_AUTH_APP_IDENTITY')
  const userDataPath = readRequiredText(environment, 'LDB_AUTH_USER_DATA_PATH')
  const hasRequiredValues =
    apiOrigin != null &&
    returnTarget != null &&
    profile != null &&
    appIdentity != null &&
    userDataPath != null
  if (!hasRequiredValues || providers == null) {
    return null
  }

  const isValidProfile = /^[a-z][a-z0-9-]{0,31}$/.test(profile)
  if (!isValidProfile) {
    return null
  }

  const hasValidAppIdentity = /^[a-zA-Z][a-zA-Z0-9.-]{0,127}$/.test(appIdentity)
  const hasNoControlPath = [...userDataPath].every((character) => {
    const code = character.charCodeAt(0)
    return code > 0x1f && code !== 0x7f
  })
  const isUserDataRoot = parse(userDataPath).root === userDataPath
  const hasValidUserDataPath = isAbsolute(userDataPath) && !isUserDataRoot && hasNoControlPath
  if (!hasValidAppIdentity || !hasValidUserDataPath) {
    return null
  }

  try {
    validateApiOrigin(apiOrigin)
    validateReturnTarget(returnTarget)
  } catch {
    return null
  }

  return { apiOrigin, returnTarget, environment: profile, providers, appIdentity, userDataPath }
}

export function applyAuthRuntimeProfile(
  application: AuthRuntimeProfileApplication,
  config: AuthRuntimeConfig
): void {
  prepareUserDataDirectory(config.userDataPath)
  application.setPath('userData', config.userDataPath)
  application.setName(config.appIdentity)
  application.setAppUserModelId(config.appIdentity)
}
