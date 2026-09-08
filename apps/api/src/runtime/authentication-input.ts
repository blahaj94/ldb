import type { AccessJwtIssuerConfiguration } from '../auth/access-jwt/types.js'
import { decodeOpaque } from '../auth/login/crypto.js'
import type {
  LoginRegistryConfiguration,
  ProviderPkceConfiguration,
  ProviderRegistration
} from '../types/login.js'

const invalidConfiguration = 'Invalid authentication configuration'

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value)
  if (!isObject) {
    throw new Error(invalidConfiguration)
  }
  const hasExpectedCount = Object.keys(value).length === fields.length
  const hasRequiredFields = fields.every((field) => {
    const hasField = Object.hasOwn(value, field)
    return hasField
  })
  const hasExactFields = hasExpectedCount && hasRequiredFields
  if (!hasExactFields) {
    throw new Error(invalidConfiguration)
  }
  // JSON object와 정확한 field 집합을 확인했다. 각 값의 type은 아래 경계에서 검사한다.
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  const isString = typeof value === 'string'
  if (!isString) {
    throw new Error(invalidConfiguration)
  }
  return value
}

function array(value: unknown): unknown[] {
  const isArray = Array.isArray(value)
  if (!isArray) {
    throw new Error(invalidConfiguration)
  }
  return value
}

function accessJwt(value: unknown): AccessJwtIssuerConfiguration {
  const input = record(value, ['issuer', 'audience', 'signingKey', 'verificationKeys'])
  const signing = record(input.signingKey, ['kid', 'privateKeyPem'])
  return {
    issuer: text(input.issuer),
    audience: text(input.audience),
    signingKey: { kid: text(signing.kid), privateKeyPem: text(signing.privateKeyPem) },
    verificationKeys: array(input.verificationKeys).map((value) => {
      const key = record(value, ['kid', 'publicKeyPem'])
      return { kid: text(key.kid), publicKeyPem: text(key.publicKeyPem) }
    })
  }
}

function providerPkce(value: unknown): ProviderPkceConfiguration {
  const input = record(value, ['activeKeyId', 'keys'])
  return {
    activeKeyId: text(input.activeKeyId),
    keys: array(input.keys).map((value) => {
      const key = record(value, ['id', 'key'])
      return { id: text(key.id), key: decodeOpaque(key.key) }
    })
  }
}

function registration(value: unknown): ProviderRegistration {
  const input = record(value, [
    'provider',
    'version',
    'providerClientId',
    'providerSecretRef',
    'callbackUrl',
    'authorizationEndpoint',
    'expectedAudience',
    'returnTarget'
  ])
  const isGoogle = input.provider === 'google'
  if (!isGoogle) {
    throw new Error(invalidConfiguration)
  }
  const target = record(input.returnTarget, ['id', 'url'])
  return {
    provider: 'google',
    version: text(input.version),
    providerClientId: text(input.providerClientId),
    providerSecretRef: text(input.providerSecretRef),
    callbackUrl: text(input.callbackUrl),
    authorizationEndpoint: text(input.authorizationEndpoint),
    expectedAudience: text(input.expectedAudience),
    returnTarget: { id: text(target.id), url: text(target.url) }
  }
}

function registry(value: unknown): LoginRegistryConfiguration {
  const input = record(value, ['apiOrigin', 'activeVersions', 'registrations'])
  const active = record(input.activeVersions, ['google'])
  return {
    apiOrigin: text(input.apiOrigin),
    activeVersions: { google: text(active.google) },
    registrations: array(input.registrations).map(registration)
  }
}

function google(value: unknown) {
  const input = record(value, ['registrations', 'secrets'])
  return {
    registrations: array(input.registrations).map((value) => {
      const entry = record(value, ['version', 'tokenEndpoint', 'jwksUri'])
      return {
        version: text(entry.version),
        tokenEndpoint: text(entry.tokenEndpoint),
        jwksUri: text(entry.jwksUri)
      }
    }),
    secrets: array(input.secrets).map((value) => {
      const entry = record(value, ['version', 'reference', 'value'])
      const secret = text(entry.value)
      const hasSecret = secret.trim().length > 0
      if (!hasSecret) {
        throw new Error(invalidConfiguration)
      }
      return { version: text(entry.version), reference: text(entry.reference), value: secret }
    })
  }
}

/** JSON 구조만 해석한다. Key·등록·URL의 의미는 기존 factory가 검사한다. */
export function parseAuthenticationInput(value: unknown) {
  const input = record(value, ['accessJwt', 'providerPkce', 'registry', 'google'])
  return {
    accessJwt: accessJwt(input.accessJwt),
    providerPkce: providerPkce(input.providerPkce),
    registry: registry(input.registry),
    google: google(input.google)
  }
}
