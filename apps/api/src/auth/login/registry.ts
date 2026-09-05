import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { AuthProvider } from '../../types/auth.js'
import type { LoginRegistryConfiguration, ProviderRegistration } from '../../types/login.js'
import type { AuthLoginRequest } from '../../database/schemas/auth-login-requests.js'

function exactUrl(value: string): URL {
  const url = new URL(value)
  if (url.href !== value || url.username || url.password || url.search || url.hash || value.includes('*')) throw new Error()
  return url
}

function validateRegistration(snapshot: ProviderRegistration, apiOrigin: string): void {
  if ((snapshot.provider !== 'google' && snapshot.provider !== 'discord') ||
    ![snapshot.version, snapshot.providerClientId, snapshot.providerSecretRef, snapshot.returnTarget.id]
      .every((value) => typeof value === 'string' && value.trim().length > 0)) throw new Error()
  if (exactUrl(snapshot.authorizationEndpoint).protocol !== 'https:' ||
    exactUrl(snapshot.callbackUrl).href !== `${apiOrigin}/auth/callback/${snapshot.provider}`) throw new Error()
  if (snapshot.provider === 'google' && snapshot.expectedAudience !== snapshot.providerClientId) throw new Error()
  if (snapshot.provider === 'discord' && snapshot.expectedAudience !== null) throw new Error()
  const target = exactUrl(snapshot.returnTarget.url)
  if (!target.hostname || target.port || !target.pathname.startsWith('/') ||
    ['http:', 'https:', 'file:', 'data:', 'javascript:', 'about:', 'blob:', 'ftp:', 'ws:', 'wss:', 'mailto:', 'tel:'].includes(target.protocol)) {
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
      if (origin.protocol !== 'https:' || origin.origin !== config.apiOrigin || origin.username || origin.password) throw new Error()
      this.apiOrigin = config.apiOrigin
      this.#active = Object.freeze(config.activeVersions)
      for (const snapshot of config.registrations) {
        validateRegistration(snapshot, this.apiOrigin)
        const key = this.key(snapshot.provider, snapshot.version)
        if (this.#snapshots.has(key)) throw new Error()
        Object.freeze(snapshot.returnTarget)
        this.#snapshots.set(key, Object.freeze(snapshot))
      }
      const active = Object.entries(this.#active)
      if (active.length === 0 || active.some(([provider, version]) =>
        (provider !== 'google' && provider !== 'discord') || !this.#snapshots.has(this.key(provider, version)))) throw new Error()
      Object.freeze(this)
    } catch { throw new LoginFailure(LOGIN_ERRORS.INTERNAL) }
  }

  private key(provider: string, version: string): string { return JSON.stringify([provider, version]) }

  active(provider: AuthProvider): ProviderRegistration {
    const version = this.#active[provider]
    const snapshot = version && this.#snapshots.get(this.key(provider, version))
    if (!snapshot) throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    return snapshot
  }

  resolve(row: Pick<AuthLoginRequest, 'provider' | 'providerConfigVersion' | 'returnTargetId'>): ProviderRegistration {
    const snapshot = this.#snapshots.get(this.key(row.provider, row.providerConfigVersion))
    if (!snapshot || snapshot.returnTarget.id !== row.returnTargetId) throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    return snapshot
  }
}
