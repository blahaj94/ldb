/* global AbortController, Response */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { registration } from './login-fixtures.mjs'

export const tokenEndpoint = 'https://google-token.test.invalid/token'
export const jwksUri = 'https://google-keys.test.invalid/certs'
export const hashNonce = (nonce) =>
  createHash('sha256').update(Buffer.from(nonce, 'base64url')).digest()
export const accessHash = (accessToken) =>
  createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16).toString('base64url')

export async function signingKey(kid = 'fixture-google-key', alg = 'RS256') {
  const keys = await generateKeyPair(alg)
  return { ...keys, jwk: { ...await exportJWK(keys.publicKey), kid, alg, use: 'sig' }, kid, alg }
}

export function verificationInput(snapshot = registration()) {
  const nonce = randomBytes(32).toString('base64url')
  const controller = new AbortController()
  return {
    nonce,
    controller,
    input: {
      snapshot,
      code: 'fixture-provider-code',
      providerVerifier: randomBytes(32).toString('base64url'),
      nonceHash: hashNonce(nonce),
      signal: controller.signal,
    },
  }
}

export async function tokenResponse(key, nonce, claims = {}, header = {}) {
  const accessToken = randomBytes(32).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: 'https://accounts.google.com',
    aud: registration().expectedAudience,
    sub: 'FixtureSubject',
    iat: now - 1,
    exp: now + 300,
    nonce,
    at_hash: accessHash(accessToken),
    name: 'fixture-profile-discard',
    email: 'fixture-email-discard',
    ...claims,
  }
  for (const field of Object.keys(payload)) {
    const isOmittedClaim = payload[field] === undefined
    if (isOmittedClaim) delete payload[field]
  }
  const idToken = await new SignJWT(payload)
    .setProtectedHeader({ alg: key.alg, kid: key.kid, ...header })
    .sign(key.privateKey)
  return { id_token: idToken, access_token: accessToken, refresh_token: 'fixture-refresh-discard' }
}

export function adapterConfiguration(key, response, overrides = {}) {
  const requests = []
  const secrets = []
  const configuration = {
    registrations: [{ snapshot: registration(), tokenEndpoint, jwksUri }],
    resolveSecret: (binding) => {
      secrets.push(binding)
      return 'fixture-client-secret'
    },
    fetch: async (url, options) => {
      const hasBody = options.body != null
      const fields = hasBody ? Object.fromEntries(options.body) : undefined
      requests.push({ url, options, fields })
      const isTokenRequest = url === tokenEndpoint
      if (isTokenRequest) return Response.json(response)
      assert.equal(url, jwksUri)
      return Response.json({ keys: [key.jwk] }, { headers: { 'cache-control': 'max-age=3600' } })
    },
    ...overrides,
  }
  return { configuration, requests, secrets }
}

export async function providerFailure(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, 'AUTH_PROVIDER_ERROR')
    assert.equal(error.message, '소셜 로그인을 완료하지 못했습니다. 다시 시도해 주세요.')
    const hasNoCause = error.cause === undefined
    const leaksProviderData = /fixture-provider-code|fixture-client-secret|FixtureSubject|fixture-raw-error/.test(String(error.stack))
    assert(hasNoCause)
    assert.equal(leaksProviderData, false)
    return true
  })
}
