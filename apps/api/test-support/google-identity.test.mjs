import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createGoogleProviderVerifier } from '../dist/auth/google/index.js'
import { registration } from './login-fixtures.mjs'
import {
  adapterConfiguration, hashNonce, providerFailure, signingKey, tokenResponse, verificationInput,
} from './google-fixtures.mjs'

const key = await signingKey()

test('Google RS256 returns only case-sensitive provider/subject and discards profile/tokens', async () => {
  for (const issuer of ['https://accounts.google.com', 'accounts.google.com']) {
    const f = verificationInput()
    const response = await tokenResponse(key, f.nonce, { iss: issuer, azp: registration().expectedAudience })
    const transport = adapterConfiguration(key, response)
    const verify = createGoogleProviderVerifier(transport.configuration)
    assert.deepEqual(await verify(f.input), { provider: 'google', subject: 'FixtureSubject' })
    const tokenRequest = transport.requests[0]
    assert.equal(tokenRequest.url, transport.configuration.registrations[0].tokenEndpoint)
    assert.deepEqual(Object.keys(tokenRequest.fields).sort(), [
      'client_id', 'client_secret', 'code', 'code_verifier', 'grant_type', 'redirect_uri',
    ])
    assert.equal(tokenRequest.fields.grant_type, 'authorization_code')
    assert(tokenRequest.fields.code === f.input.code)
    assert(tokenRequest.fields.code_verifier === f.input.providerVerifier)
    assert(tokenRequest.fields.client_secret === 'fixture-client-secret')
    assert.equal(tokenRequest.fields.client_id, f.input.snapshot.providerClientId)
    assert.equal(tokenRequest.fields.redirect_uri, f.input.snapshot.callbackUrl)
    assert.equal(tokenRequest.options.body, undefined)
    assert(transport.requests.every(({ options }) => options.signal === f.input.signal))
    assert(transport.requests.every(({ options }) => options.redirect === 'error'))
    assert.deepEqual(transport.secrets[0], {
      version: f.input.snapshot.version,
      reference: f.input.snapshot.providerSecretRef,
      signal: f.input.signal,
    })
  }
})

test('Google signed claims reject wrong canonical identity, audience, time, nonce and at_hash', async (t) => {
  const now = Math.floor(Date.now() / 1000)
  const claims = [
    ['issuer', { iss: 'https://attacker.test.invalid' }],
    ['missing issuer', { iss: undefined }],
    ['audience', { aud: 'desktop' }],
    ['audience array', { aud: [registration().expectedAudience] }],
    ['missing audience', { aud: undefined }],
    ['azp', { azp: 'other-client' }],
    ['azp type', { azp: [registration().expectedAudience] }],
    ['missing expiration', { exp: undefined }],
    ['expired equality', { exp: now }],
    ['missing issued time', { iat: undefined }],
    ['future issued time', { iat: now + 120 }],
    ['issued time type', { iat: '123' }],
    ['empty subject', { sub: '' }],
    ['non-ASCII subject', { sub: '사용자' }],
    ['long subject', { sub: 'a'.repeat(256) }],
    ['subject type', { sub: 123 }],
    ['missing subject', { sub: undefined }],
    ['missing nonce', { nonce: undefined }],
    ['wrong nonce', { nonce: Buffer.alloc(32).toString('base64url') }],
    ['wrong access hash', { at_hash: Buffer.alloc(16).toString('base64url') }],
    ['access hash type', { at_hash: 123 }],
  ]
  for (const [name, changes] of claims) {
    await t.test(name, async () => {
      const f = verificationInput()
      const transport = adapterConfiguration(key, await tokenResponse(key, f.nonce, changes))
      await providerFailure(createGoogleProviderVerifier(transport.configuration)(f.input))
    })
  }
})

test('nonce hashes canonical decoded 32 bytes, never PKCE ASCII text', async () => {
  const nonce = Buffer.alloc(32).toString('base64url')
  for (const invalidNonce of [`${nonce}=`, `${nonce.slice(0, -1)}B`, nonce.slice(1), ` ${nonce}`]) {
    const f = verificationInput()
    f.input.nonceHash = hashNonce(nonce)
    const transport = adapterConfiguration(key, await tokenResponse(key, invalidNonce))
    await providerFailure(createGoogleProviderVerifier(transport.configuration)(f.input))
  }
  for (const invalidHash of [null, Buffer.alloc(31), createHash('sha256').update(nonce, 'ascii').digest()]) {
    const f = verificationInput()
    f.input.nonceHash = invalidHash
    const transport = adapterConfiguration(key, await tokenResponse(key, nonce))
    await providerFailure(createGoogleProviderVerifier(transport.configuration)(f.input))
  }
})

test('optional at_hash may be absent; present hash requires exact canonical value and access token', async () => {
  const f = verificationInput()
  const response = await tokenResponse(key, f.nonce, { at_hash: undefined, sub: 'A'.repeat(255) })
  const transport = adapterConfiguration(key, response)
  assert.equal((await createGoogleProviderVerifier(transport.configuration)(f.input)).subject.length, 255)
  const signed = await tokenResponse(key, f.nonce)
  for (const accessToken of [undefined, '', 'wrong-access-token']) {
    const invalid = adapterConfiguration(key, { ...signed, access_token: accessToken })
    await providerFailure(createGoogleProviderVerifier(invalid.configuration)(f.input))
  }
})

test('signature and algorithm trust reject forged RSA and own ES256 token keys', async () => {
  for (const wrongKey of [await signingKey(key.kid), await signingKey(key.kid, 'ES256')]) {
    const f = verificationInput()
    const transport = adapterConfiguration(key, await tokenResponse(wrongKey, f.nonce))
    await providerFailure(createGoogleProviderVerifier(transport.configuration)(f.input))
  }
})
