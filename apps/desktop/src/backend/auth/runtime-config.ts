import * as fs from 'node:fs'
import { dirname, isAbsolute, join, normalize, parse, sep } from 'node:path'
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
  getPath(name: 'userData'): string
  setName(name: string): void
  setAppUserModelId(id: string): void
}>

export class AuthRuntimeProfileApplicationFailure extends Error {
  constructor() {
    super('Trusted runtime profile could not be applied.')
    this.name = 'AuthRuntimeProfileApplicationFailure'
  }
}

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>
type RuntimePathSemantics = Readonly<{
  dirname(path: string): string
  isAbsolute(path: string): boolean
  join(...paths: string[]): string
  normalize(path: string): string
  parse(path: string): ReturnType<typeof parse>
  sep: string
}>
type RuntimeProfileFilesystem = Readonly<
  Pick<typeof fs, 'lstatSync' | 'mkdirSync' | 'openSync' | 'fsyncSync' | 'closeSync'> & {
    realpathSync(path: string): string
  }
>

const nativeRuntimeProfileFilesystem: RuntimeProfileFilesystem = {
  lstatSync: fs.lstatSync,
  realpathSync: fs.realpathSync.native,
  mkdirSync: fs.mkdirSync,
  openSync: fs.openSync,
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync
}
const nativeRuntimePathSemantics: RuntimePathSemantics = {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  sep
}

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

function isAlreadyExists(error: unknown): boolean {
  const hasError = error != null
  if (!hasError || typeof error !== 'object' || !('code' in error)) {
    return false
  }

  return error.code === 'EEXIST'
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

function assertTrustedAncestorDirectory(stat: Stats): void {
  const isDirectory = stat.isDirectory()
  const isSymlink = stat.isSymbolicLink()
  const uid = process.getuid?.()
  const hasPrivatePosixProtection =
    uid == null || ((stat.uid === 0 || stat.uid === uid) && (stat.mode & 0o022) === 0)
  const isTrustedDirectory = isDirectory && !isSymlink && hasPrivatePosixProtection
  if (!isTrustedDirectory) {
    throw new Error('Trusted userData directory is unavailable.')
  }
}

function assertCanonicalPath(path: string, filesystem: RuntimeProfileFilesystem): void {
  const canonicalPath = filesystem.realpathSync(path)
  if (canonicalPath !== path) {
    throw new Error('Trusted userData path must use its native canonical spelling.')
  }
}

function splitNativePath(path: string, pathSemantics: RuntimePathSemantics): string[] {
  const separator = pathSemantics.sep === '\\' ? /[\\/]/ : /\//
  return path.split(separator)
}

function hasPathAlias(path: string, pathSemantics: RuntimePathSemantics): boolean {
  const hasNonNativeSeparator = pathSemantics.sep === '\\' && path.includes('/')
  const hasNonCanonicalSpelling = pathSemantics.normalize(path) !== path
  const root = pathSemantics.parse(path).root
  const segments = splitNativePath(path.slice(root.length), pathSemantics)
  const hasDotSegment = segments.some((segment) => segment === '.' || segment === '..')
  const hasEmptySegment = segments.some((segment) => segment.length === 0)
  const hasWin32NormalizedSegment =
    pathSemantics.sep === '\\' && segments.some((segment) => /[ .]$/.test(segment))
  return (
    hasNonNativeSeparator ||
    hasNonCanonicalSpelling ||
    hasDotSegment ||
    hasEmptySegment ||
    hasWin32NormalizedSegment
  )
}

function directoryChain(path: string, pathSemantics: RuntimePathSemantics): string[] {
  const root = pathSemantics.parse(path).root
  const segments = splitNativePath(path.slice(root.length), pathSemantics).filter(Boolean)
  let current = root
  return segments.map((segment) => {
    current = pathSemantics.join(current, segment)
    return current
  })
}

function syncDirectory(path: string, filesystem: RuntimeProfileFilesystem): void {
  if (process.platform === 'win32') {
    return
  }

  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  const handle = filesystem.openSync(path, flags)
  try {
    filesystem.fsyncSync(handle)
  } finally {
    filesystem.closeSync(handle)
  }
}

function prepareUserDataDirectory(
  path: string,
  filesystem: RuntimeProfileFilesystem,
  pathSemantics: RuntimePathSemantics
): void {
  if (hasPathAlias(path, pathSemantics)) {
    throw new Error('Trusted userData path must not use path aliases.')
  }

  const paths = directoryChain(path, pathSemantics)
  const finalPath = paths[paths.length - 1]
  for (const currentPath of paths) {
    let stat: Stats
    let created = false
    try {
      stat = filesystem.lstatSync(currentPath)
    } catch (error) {
      const isMissingPath = isMissing(error)
      if (!isMissingPath) {
        throw error
      }
      const parentPath = pathSemantics.dirname(currentPath)
      assertTrustedAncestorDirectory(filesystem.lstatSync(parentPath))
      assertCanonicalPath(parentPath, filesystem)
      try {
        filesystem.mkdirSync(currentPath, { mode: 0o700 })
      } catch (mkdirError) {
        const wasCreatedConcurrently = isAlreadyExists(mkdirError)
        if (!wasCreatedConcurrently) {
          throw mkdirError
        }
      }
      stat = filesystem.lstatSync(currentPath)
      created = true
    }

    const isFinalPath = currentPath === finalPath
    if (isFinalPath) {
      assertPrivateUserDataDirectory(stat)
    } else {
      assertTrustedAncestorDirectory(stat)
    }
    assertCanonicalPath(currentPath, filesystem)
    if (created) {
      const parentPath = pathSemantics.dirname(currentPath)
      syncDirectory(currentPath, filesystem)
      syncDirectory(parentPath, filesystem)
      const grandparentPath = pathSemantics.dirname(parentPath)
      if (grandparentPath !== parentPath) {
        syncDirectory(grandparentPath, filesystem)
      }
    }
  }

  const finalParentPath = pathSemantics.dirname(finalPath)
  assertTrustedAncestorDirectory(filesystem.lstatSync(finalParentPath))
  syncDirectory(finalPath, filesystem)
  syncDirectory(finalParentPath, filesystem)
}

export function readAuthRuntimeConfig(
  environment: RuntimeEnvironment = process.env,
  pathSemantics: RuntimePathSemantics = nativeRuntimePathSemantics
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
  const hasNoPathAlias = !hasPathAlias(userDataPath, pathSemantics)
  const isUserDataRoot = pathSemantics.parse(userDataPath).root === userDataPath
  const hasValidUserDataPath =
    pathSemantics.isAbsolute(userDataPath) && !isUserDataRoot && hasNoControlPath && hasNoPathAlias
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
  config: AuthRuntimeConfig,
  filesystem: RuntimeProfileFilesystem = nativeRuntimeProfileFilesystem,
  pathSemantics: RuntimePathSemantics = nativeRuntimePathSemantics
): AuthRuntimeConfig {
  prepareUserDataDirectory(config.userDataPath, filesystem, pathSemantics)
  try {
    application.setPath('userData', config.userDataPath)
    const appliedUserDataPath = application.getPath('userData')
    if (appliedUserDataPath !== config.userDataPath) {
      throw new Error('Electron applied a different userData path.')
    }
    application.setName(config.appIdentity)
    application.setAppUserModelId(config.appIdentity)
    return { ...config, userDataPath: appliedUserDataPath }
  } catch {
    throw new AuthRuntimeProfileApplicationFailure()
  }
}
