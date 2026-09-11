import { validateApiOrigin, validateReturnTarget } from './protocol'
import type { AuthProvider } from './types'

export type AuthRuntimeConfig = Readonly<{
  apiOrigin: string
  returnTarget: string
  environment: string
  providers: readonly AuthProvider[]
}>

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>

function isAuthProvider(value: string): value is AuthProvider {
  const isGoogle = value === 'google'
  const isDiscord = value === 'discord'
  const isSupported = isGoogle || isDiscord

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

export function readAuthRuntimeConfig(
  environment: RuntimeEnvironment = process.env
): AuthRuntimeConfig | null {
  const apiOrigin = readRequiredText(environment, 'LDB_AUTH_API_ORIGIN')
  const returnTarget = readRequiredText(environment, 'LDB_AUTH_RETURN_TARGET')
  const profile = readRequiredText(environment, 'LDB_AUTH_ENVIRONMENT')
  const providers = readProviders(environment)
  const hasRequiredValues = apiOrigin != null && returnTarget != null && profile != null
  if (!hasRequiredValues || providers == null) {
    return null
  }

  const isValidProfile = /^[a-z][a-z0-9-]{0,31}$/.test(profile)
  if (!isValidProfile) {
    return null
  }

  try {
    validateApiOrigin(apiOrigin)
    validateReturnTarget(returnTarget)
  } catch {
    return null
  }

  return { apiOrigin, returnTarget, environment: profile, providers }
}
