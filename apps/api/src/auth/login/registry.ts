import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { AuthProvider } from '../../types/auth.js'
import type { LoginRegistryConfiguration, ProviderRegistration } from '../../types/login.js'
import type { AuthLoginRequest } from '../../database/schemas/auth-login-requests.js'

function exactUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.href !== value ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes('*')
  ) {
    throw new Error()
  }
  return url
}

function validateRegistration(snapshot: ProviderRegistration, apiOrigin: string): void {
  // 1. 등록 항목의 provider와 식별값을 확인한다.
  if (snapshot.provider !== 'google' && snapshot.provider !== 'discord') {
    throw new Error()
  }

  const requiredValues = [
    snapshot.version,
    snapshot.providerClientId,
    snapshot.providerSecretRef,
    snapshot.returnTarget.id,
  ]
  if (!requiredValues.every((value) => typeof value === 'string' && value.trim().length > 0)) {
    throw new Error()
  }

  // 2. Provider endpoint와 이 API의 exact callback에만 연결한다.
  if (
    exactUrl(snapshot.authorizationEndpoint).protocol !== 'https:' ||
    exactUrl(snapshot.callbackUrl).href !== `${apiOrigin}/auth/callback/${snapshot.provider}`
  ) {
    throw new Error()
  }
  if (snapshot.provider === 'google' && snapshot.expectedAudience !== snapshot.providerClientId) {
    throw new Error()
  }
  if (snapshot.provider === 'discord' && snapshot.expectedAudience !== null) {
    throw new Error()
  }

  // 3. 앱 복귀 URL은 host/path가 있는 등록 protocol이어야 한다.
  const target = exactUrl(snapshot.returnTarget.url)
  const disallowedProtocols = [
    'http:', 'https:', 'file:', 'data:', 'javascript:', 'about:',
    'blob:', 'ftp:', 'ws:', 'wss:', 'mailto:', 'tel:',
  ]
  if (
    !target.hostname ||
    target.port ||
    !target.pathname.startsWith('/') ||
    disallowedProtocols.includes(target.protocol)
  ) {
    throw new Error()
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
      if (
        origin.protocol !== 'https:' ||
        origin.origin !== config.apiOrigin ||
        origin.username ||
        origin.password
      ) {
        throw new Error()
      }
      this.apiOrigin = config.apiOrigin
      this.#active = Object.freeze(config.activeVersions)

      // 요청이 생성된 당시 version을 이후에도 해석하도록 각 snapshot을 보존한다.
      for (const snapshot of config.registrations) {
        validateRegistration(snapshot, this.apiOrigin)
        const key = this.registrationKey(snapshot.provider, snapshot.version)
        if (this.#snapshots.has(key)) {
          throw new Error()
        }
        Object.freeze(snapshot.returnTarget)
        this.#snapshots.set(key, Object.freeze(snapshot))
      }

      const activeVersions = Object.entries(this.#active)
      if (
        activeVersions.length === 0 ||
        activeVersions.some(([provider, version]) =>
          (provider !== 'google' && provider !== 'discord') ||
          !this.#snapshots.has(this.registrationKey(provider, version)))
      ) {
        throw new Error()
      }
      Object.freeze(this)
    } catch {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
  }

  private registrationKey(provider: string, version: string): string {
    return JSON.stringify([provider, version])
  }

  /** 새 요청은 현재 active version으로 시작한다. */
  active(provider: AuthProvider): ProviderRegistration {
    const version = this.#active[provider]
    const snapshot = version && this.#snapshots.get(this.registrationKey(provider, version))
    if (!snapshot) {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
    return snapshot
  }

  /** 진행 중인 요청은 저장된 version과 복귀 대상을 그대로 사용한다. */
  resolve(
    request: Pick<AuthLoginRequest, 'provider' | 'providerConfigVersion' | 'returnTargetId'>,
  ): ProviderRegistration {
    const key = this.registrationKey(request.provider, request.providerConfigVersion)
    const snapshot = this.#snapshots.get(key)
    if (!snapshot || snapshot.returnTarget.id !== request.returnTargetId) {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
    return snapshot
  }
}
