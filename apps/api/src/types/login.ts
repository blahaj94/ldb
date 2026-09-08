import type { LOGIN_ERRORS } from '../constants/login.js'
import type { AuthProvider, VerifiedIdentity } from './auth.js'
import type { IssueAccessJwt } from '../auth/access-jwt/types.js'
import type { DataSource } from 'typeorm'
import type { LoginRegistry } from '../auth/login/registry.js'
import type { ProviderPkceKeys } from '../auth/login/crypto.js'
import type { AuthLoginRequest } from '../database/schemas/auth-login-requests.js'
import type { RefreshTokens } from '../auth/refresh/types.js'

export type LoginErrorDefinition = (typeof LOGIN_ERRORS)[keyof typeof LOGIN_ERRORS]

export interface LoginCreation {
  provider: AuthProvider
  clientId: 'desktop'
  codeChallenge: string
  codeChallengeMethod: 'S256'
}

export interface LoginExchange {
  requestId: string
  clientId: string
  code: string
  codeVerifier: string
}

export type LoginCallbackInput =
  | { state: string; code: string; error?: undefined }
  | { state: string; code?: undefined; error: string }

export interface ProviderRegistration {
  readonly provider: AuthProvider
  readonly version: string
  readonly providerClientId: string
  readonly providerSecretRef: string
  readonly callbackUrl: string
  readonly authorizationEndpoint: string
  readonly expectedAudience: string | null
  readonly returnTarget: {
    readonly id: string
    readonly url: string
  }
}

export interface LoginRegistryConfiguration {
  readonly apiOrigin: string
  readonly activeVersions: Readonly<Partial<Record<AuthProvider, string>>>
  readonly registrations: readonly ProviderRegistration[]
}

export interface ProviderPkceConfiguration {
  readonly activeKeyId: string
  readonly keys: readonly {
    readonly id: string
    readonly key: Buffer
  }[]
}

/** 서버의 검증 adapter만 구현한다. HTTP body·query에서 adapter/identity를 공급하지 않는다. */
export interface ProviderVerificationInput {
  readonly snapshot: ProviderRegistration
  readonly code: string
  readonly providerVerifier: string
  readonly nonceHash: Buffer | null
  readonly signal: AbortSignal
}

export interface LoginDependencies {
  readonly dataSource: DataSource
  readonly registry: LoginRegistry
  readonly pkceKeys: ProviderPkceKeys
  readonly issueAccessJwt: IssueAccessJwt
  readonly verifyProvider: (input: ProviderVerificationInput) => Promise<VerifiedIdentity>
}

export interface ClaimedLogin {
  row: AuthLoginRequest
  snapshot: ProviderRegistration
  providerVerifier: string
  startedAt: number
}

export interface LoginTokens {
  tokenType: 'Bearer'
  accessToken: string
  accessTokenExpiresAt: string
  refreshToken: string
  sessionExpiresAt: string
  user: {
    id: string
    nickname: string
  }
  isNewUser: boolean
}

export interface CreatedLoginRequest {
  requestId: string
  browserUrl: string
  expiresAt: string
}

export interface LoginAuthorization {
  redirectUrl: string
  cookie: string
}

export interface CompletedLoginCallback {
  returnUrl: string
  cookie: string
}

export interface LoginHttpService {
  create(input: unknown): Promise<CreatedLoginRequest>
  authorize(ticket: string): Promise<LoginAuthorization>
  callback(
    provider: AuthProvider,
    query: URLSearchParams,
    cookieHeader: string
  ): Promise<CompletedLoginCallback>
  exchange(input: unknown): Promise<LoginTokens>
}

export interface SessionHttpService {
  refresh(rawToken: string): Promise<RefreshTokens>
  logout(rawToken: string): Promise<void>
}
