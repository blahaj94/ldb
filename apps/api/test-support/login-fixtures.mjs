import { randomBytes } from 'node:crypto'

// 격리된 test 등록값이다. 제품 registry/환경변수/credential로 export하지 않는다.
export function registration(provider = 'google', version = 'test-v1') {
  return {
    provider,
    version,
    providerClientId: `${provider}-test-client`,
    providerSecretRef: `${provider}-test-secret-reference`,
    callbackUrl: `https://api.test.invalid/auth/callback/${provider}`,
    authorizationEndpoint: `https://${provider}.test.invalid/authorize`,
    expectedAudience: provider === 'google' ? 'google-test-client' : null,
    returnTarget: { id: `test-return-${version}`, url: 'ldb-test://login/complete' }
  }
}

export function registryConfiguration() {
  return {
    apiOrigin: 'https://api.test.invalid',
    activeVersions: { google: 'test-v1', discord: 'test-v1' },
    registrations: [registration(), registration('discord')]
  }
}

export const opaque = () => randomBytes(32).toString('base64url')

export function creation(codeChallenge, provider = 'google') {
  return { provider, clientId: 'desktop', codeChallenge, codeChallengeMethod: 'S256' }
}
