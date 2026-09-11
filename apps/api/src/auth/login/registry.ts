import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { AuthProvider } from '../../types/auth.js'
import type { LoginRegistryConfiguration, ProviderRegistration } from '../../types/login.js'
import type { AuthLoginRequest } from '../../database/schemas/auth-login-requests.js'

function exactUrl(value: string): URL {
  const url = new URL(value)
  const hasExactHref = url.href === value
  if (!hasExactHref) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  const hasUsername = Boolean(url.username)
  if (hasUsername) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  const hasPassword = Boolean(url.password)
  if (hasPassword) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  const hasSearch = Boolean(url.search)
  if (hasSearch) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  const hasHash = Boolean(url.hash)
  if (hasHash) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  const hasWildcard = value.includes('*')
  if (hasWildcard) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  return url
}

function validateRegistration(snapshot: ProviderRegistration, apiOrigin: string): void {
  // 1. 등록 항목의 provider와 식별값을 확인한다.
  const isGoogleProvider = snapshot.provider === 'google'
  const isDiscordProvider = snapshot.provider === 'discord'
  const isProviderInvalid = !isGoogleProvider && !isDiscordProvider
  if (isProviderInvalid) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }

  const requiredValues = [
    snapshot.version,
    snapshot.providerClientId,
    snapshot.providerSecretRef,
    snapshot.returnTarget.id
  ]
  const hasRequiredValues = requiredValues.every((value) => {
    const isValueString = typeof value === 'string'
    if (!isValueString) {
      return false
    }
    const hasNonblankValue = value.trim().length > 0
    return hasNonblankValue
  })
  if (!hasRequiredValues) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }

  // 2. Provider endpoint와 이 API의 exact callback에만 연결한다.
  const isAuthorizationHttps = exactUrl(snapshot.authorizationEndpoint).protocol === 'https:'
  if (!isAuthorizationHttps) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  const callbackHref = exactUrl(snapshot.callbackUrl).href
  const expectedCallback = `${apiOrigin}/auth/callback/${snapshot.provider}`
  const hasExactCallback = callbackHref === expectedCallback
  if (!hasExactCallback) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  const isGoogleProviderForAudience = snapshot.provider === 'google'
  if (isGoogleProviderForAudience) {
    const hasMatchingGoogleAudience = snapshot.expectedAudience === snapshot.providerClientId
    if (!hasMatchingGoogleAudience) {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
  }

  const isDiscordProviderForAudience = snapshot.provider === 'discord'
  if (isDiscordProviderForAudience) {
    const hasNoDiscordAudience = snapshot.expectedAudience === null
    if (!hasNoDiscordAudience) {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
  }

  // 3. 앱 복귀 URL은 host/path가 있는 등록 protocol이어야 한다.
  const target = exactUrl(snapshot.returnTarget.url)
  const disallowedProtocols = [
    'http:',
    'https:',
    'file:',
    'data:',
    'javascript:',
    'about:',
    'blob:',
    'ftp:',
    'ws:',
    'wss:',
    'mailto:',
    'tel:'
  ]
  const hasHostname = Boolean(target.hostname)
  if (!hasHostname) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  const hasPort = Boolean(target.port)
  if (hasPort) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  const hasAbsolutePath = target.pathname.startsWith('/')
  if (!hasAbsolutePath) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  const isProtocolDisallowed = disallowedProtocols.includes(target.protocol)
  if (isProtocolDisallowed) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
}

/** 설정은 listen 전에 검증하고 복제한다. Runtime request는 저장한 version만 해석한다. */
export class LoginRegistry {
  readonly apiOrigin: string
  readonly #snapshots = new Map<string, ProviderRegistration>()
  readonly #active: Readonly<Partial<Record<AuthProvider, string>>>

  constructor(configuration: LoginRegistryConfiguration) {
    try {
      const config = structuredClone(configuration)
      const origin = new URL(config.apiOrigin)
      const isOriginHttps = origin.protocol === 'https:'
      if (!isOriginHttps) {
        throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
      }
      const hasExactOrigin = origin.origin === config.apiOrigin
      if (!hasExactOrigin) {
        throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
      }
      const hasOriginUsername = Boolean(origin.username)
      if (hasOriginUsername) {
        throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
      }
      const hasOriginPassword = Boolean(origin.password)
      if (hasOriginPassword) {
        throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
      }
      this.apiOrigin = config.apiOrigin
      this.#active = Object.freeze(config.activeVersions)

      // 요청이 생성된 당시 version을 이후에도 해석하도록 각 snapshot을 보존한다.
      for (const snapshot of config.registrations) {
        validateRegistration(snapshot, this.apiOrigin)
        const key = this.registrationKey({ provider: snapshot.provider, version: snapshot.version })
        const isDuplicateRegistration = this.#snapshots.has(key)
        if (isDuplicateRegistration) {
          throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
        }
        Object.freeze(snapshot.returnTarget)
        this.#snapshots.set(key, Object.freeze(snapshot))
      }

      const activeVersions = Object.entries(this.#active)
      const hasNoActiveVersions = activeVersions.length === 0
      if (hasNoActiveVersions) {
        throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
      }
      const hasInvalidActiveVersion = activeVersions.some(([provider, version]) => {
        const isSupportedProvider = provider === 'google' || provider === 'discord'
        if (!isSupportedProvider) {
          return true
        }
        const hasRegistration = this.#snapshots.has(this.registrationKey({ provider, version }))
        const isActiveVersionInvalid = !hasRegistration
        return isActiveVersionInvalid
      })
      if (hasInvalidActiveVersion) {
        throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
      }
      Object.freeze(this)
    } catch {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
  }

  private registrationKey({ provider, version }: { provider: string; version: string }): string {
    return JSON.stringify([provider, version])
  }

  /** 새 요청은 현재 active version으로 시작한다. */
  active(provider: AuthProvider): ProviderRegistration {
    const version = this.#active[provider]
    const hasVersion = version != null
    if (!hasVersion) {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
    const hasTruthyVersion = Boolean(version)
    if (!hasTruthyVersion) {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
    const snapshot = this.#snapshots.get(this.registrationKey({ provider, version }))
    const hasSnapshot = snapshot != null
    if (!hasSnapshot) {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
    return snapshot
  }

  /** 진행 중인 요청은 저장된 version과 복귀 대상을 그대로 사용한다. */
  resolve(
    request: Pick<AuthLoginRequest, 'provider' | 'providerConfigVersion' | 'returnTargetId'>
  ): ProviderRegistration {
    const key = this.registrationKey({
      provider: request.provider,
      version: request.providerConfigVersion
    })
    const snapshot = this.#snapshots.get(key)
    const hasSnapshot = snapshot != null
    if (!hasSnapshot) {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
    const hasSameReturnTarget = snapshot.returnTarget.id === request.returnTargetId
    if (!hasSameReturnTarget) {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
    return snapshot
  }
}
