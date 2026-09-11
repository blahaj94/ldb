import assert from 'node:assert/strict'
import test from 'node:test'
import { readBearerToken } from '../src/auth/bearer.js'
import { LoginRegistry } from '../src/auth/login/registry.js'
import type { LoginRegistryConfiguration, ProviderRegistration } from '../src/types/login.js'

const apiOrigin = 'https://api.test.invalid'

function registration(
  provider: ProviderRegistration['provider'],
  overrides: Partial<ProviderRegistration> = {}
): ProviderRegistration {
  const isGoogleProvider = provider === 'google'
  return {
    provider,
    version: 'test-v1',
    providerClientId: `${provider}-test-client`,
    providerSecretRef: `${provider}-test-secret-reference`,
    callbackUrl: `${apiOrigin}/auth/callback/${provider}`,
    authorizationEndpoint: `https://${provider}.test.invalid/authorize`,
    expectedAudience: isGoogleProvider ? `${provider}-test-client` : null,
    returnTarget: { id: `test-return-${provider}`, url: 'ldb-test://login/complete' },
    ...overrides
  }
}

function registryConfiguration(
  registrations: readonly ProviderRegistration[]
): LoginRegistryConfiguration {
  return {
    apiOrigin,
    activeVersions: { google: 'test-v1', discord: 'test-v1' },
    registrations
  }
}

test('Bearer header parsing skips raw value positions before lower-case comparison', () => {
  const rawValue = {
    toLowerCase() {
      throw new Error('raw header values must not be normalized')
    }
  }
  const rawHeaders = [
    'X-Trace',
    rawValue,
    'Authorization',
    'Bearer access-token'
  ] as unknown as readonly string[]

  assert.equal(readBearerToken(rawHeaders), 'access-token')
})

test('provider audience validation remains scoped to Google and Discord branches', () => {
  const validRegistry = new LoginRegistry(
    registryConfiguration([registration('google'), registration('discord')])
  )
  assert.equal(validRegistry.active('google').expectedAudience, 'google-test-client')
  assert.equal(validRegistry.active('discord').expectedAudience, null)

  const invalidGoogle = registryConfiguration([
    registration('google', { expectedAudience: 'other-client' }),
    registration('discord')
  ])
  assert.throws(() => new LoginRegistry(invalidGoogle), { code: 'AUTH_INTERNAL_ERROR' })

  const invalidDiscord = registryConfiguration([
    registration('google'),
    registration('discord', { expectedAudience: 'discord-test-client' })
  ])
  assert.throws(() => new LoginRegistry(invalidDiscord), { code: 'AUTH_INTERNAL_ERROR' })
})
