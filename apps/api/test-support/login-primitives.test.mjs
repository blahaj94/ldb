import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { URLSearchParams } from 'node:url'
import { creation, opaque, registration, registryConfiguration } from './login-fixtures.mjs'

const crypto = await import('../dist/auth/login/crypto.js')
const { LoginRegistry } = await import('../dist/auth/login/registry.js')
const { parseCreation, parseExchange, parseCallback } = await import('../dist/auth/login/input.js')
const { exchangeExpired } = await import('../dist/auth/login/state.js')

test('app S256 and opaque code hashes have distinct exact inputs', () => {
  const value = opaque()
  assert.equal(
    crypto.challenge(value),
    createHash('sha256').update(value, 'ascii').digest('base64url')
  )
  assert.deepEqual(
    crypto.opaqueHash(value),
    createHash('sha256').update(Buffer.from(value, 'base64url')).digest()
  )
  assert.notDeepEqual(crypto.opaqueHash(value), createHash('sha256').update(value).digest())
  const noncanonical = 'A'.repeat(42) + 'B'
  for (const bad of [
    null,
    1,
    '',
    value + '=',
    ' ' + value,
    value.slice(1),
    noncanonical,
    '+'.repeat(43)
  ]) {
    assert.throws(() => crypto.decodeOpaque(bad), { code: 'INVALID_AUTH_REQUEST' })
  }
})

test('strict creation/exchange shapes reject injected identity, redirect and noncanonical proofs', () => {
  const verifier = opaque()
  const body = creation(crypto.challenge(verifier))
  assert.deepEqual(parseCreation(body), body)
  for (const bad of [
    null,
    [],
    { ...body, subject: 'untrusted' },
    { ...body, redirectUri: 'https://evil.invalid' },
    { ...body, provider: 'other' },
    { ...body, clientId: 'web' },
    { ...body, codeChallengeMethod: 'plain' },
    { ...body, codeChallenge: 'A'.repeat(42) + 'B' }
  ]) {
    assert.throws(() => parseCreation(bad), { code: 'INVALID_AUTH_REQUEST' })
  }
  const exchange = {
    requestId: randomUUID(),
    clientId: 'desktop',
    code: opaque(),
    codeVerifier: verifier
  }
  assert.deepEqual(parseExchange(exchange), exchange)
  // String client 불일치는 구조 오류가 아니라 service의 LOGIN_EXCHANGE_INVALID다.
  assert.equal(parseExchange({ ...exchange, clientId: 'web' }).clientId, 'web')
  for (const bad of [
    { ...exchange, userId: randomUUID() },
    { ...exchange, clientId: 1 },
    { ...exchange, requestId: 'not-uuid' },
    { ...exchange, code: 'A'.repeat(42) + 'B' },
    { ...exchange, codeVerifier: verifier + '=' }
  ]) {
    assert.throws(() => parseExchange(bad), { code: 'INVALID_AUTH_REQUEST' })
  }
})

test('field-count rejection does not inspect fields after the count mismatch', () => {
  let descriptorReads = 0
  const body = new Proxy(
    {
      provider: 'google',
      clientId: 'desktop',
      codeChallenge: 'extra',
      codeChallengeMethod: 'S256',
      extra: true
    },
    {
      getOwnPropertyDescriptor(target, property) {
        descriptorReads++
        const isAfterObjectKeys = descriptorReads > 5
        if (isAfterObjectKeys) {
          throw new Error('field inspection should not run')
        }
        return Object.getOwnPropertyDescriptor(target, property)
      },
      ownKeys: (target) => Reflect.ownKeys(target)
    }
  )
  assert.throws(() => parseCreation(body), { code: 'INVALID_AUTH_REQUEST' })
})

test('creation validation keeps provider and client guards short-circuiting later reads', () => {
  const providerRejected = new Proxy(creation(opaque()), {
    get(target, property) {
      const isLaterCreationField = property === 'clientId' || property === 'codeChallengeMethod'
      if (isLaterCreationField) {
        throw new Error('later creation field should not be read')
      }
      return Reflect.get(target, property)
    }
  })
  providerRejected.provider = 'other'
  assert.throws(() => parseCreation(providerRejected), { code: 'INVALID_AUTH_REQUEST' })

  const clientRejected = new Proxy(creation(opaque()), {
    get(target, property) {
      const isCodeChallengeMethod = property === 'codeChallengeMethod'
      if (isCodeChallengeMethod) {
        throw new Error('method should not be read')
      }
      return Reflect.get(target, property)
    }
  })
  clientRejected.clientId = 'web'
  assert.throws(() => parseCreation(clientRejected), { code: 'INVALID_AUTH_REQUEST' })
})

test('exchange validation preserves requestId reads and guard short-circuiting', () => {
  const verifier = opaque()
  let requestIdReads = 0
  const requestIdChanges = {
    clientId: 'desktop',
    code: opaque(),
    codeVerifier: verifier,
    get requestId() {
      requestIdReads++
      const isFirstRequestIdRead = requestIdReads === 1
      return isFirstRequestIdRead ? randomUUID() : 'not-uuid'
    }
  }
  assert.throws(() => parseExchange(requestIdChanges), { code: 'INVALID_AUTH_REQUEST' })
  assert.equal(requestIdReads, 2)

  const invalidRequestId = new Proxy(
    { requestId: 'not-uuid', clientId: 'desktop', code: opaque(), codeVerifier: verifier },
    {
      get(target, property) {
        const isClientId = property === 'clientId'
        if (isClientId) {
          throw new Error('clientId should not be read')
        }
        return Reflect.get(target, property)
      }
    }
  )
  assert.throws(() => parseExchange(invalidRequestId), { code: 'INVALID_AUTH_REQUEST' })
})

test('expired requests do not inspect code expiry after request expiry', () => {
  const checkedAt = new Date('2026-09-06T00:10:00Z')
  const request = {
    expiresAt: checkedAt,
    get codeExpiresAt() {
      throw new Error('code expiry should not be read')
    }
  }
  assert.equal(exchangeExpired(request, checkedAt), true)
})

test('callback rejects duplicate/conflicting required fields but ignores standard unknown fields', () => {
  const state = opaque()
  assert.deepEqual(
    parseCallback(new URLSearchParams({ state, code: 'provider-code', scope: 'openid profile' })),
    { state, code: 'provider-code', error: undefined }
  )
  for (const query of [
    `state=${state}&state=${state}&code=x`,
    `state=${state}&code=x&code=y`,
    `state=${state}&error=x&error=y`,
    `state=${state}&code=x&error=access_denied`,
    'code=x',
    `state=${state}`,
    `state=${state}&code=`
  ]) {
    assert.throws(() => parseCallback(new URLSearchParams(query)), {
      code: 'LOGIN_REQUEST_INVALID'
    })
  }
})

test('registry validates exact trusted URLs and freezes historical snapshot semantics', () => {
  const config = registryConfiguration()
  config.registrations.push(registration('google', 'test-v2'))
  config.activeVersions.google = 'test-v2'
  const registry = new LoginRegistry(config)
  const row = {
    provider: 'google',
    providerConfigVersion: 'test-v1',
    returnTargetId: 'test-return-test-v1'
  }
  assert.equal(registry.resolve(row).version, 'test-v1')
  assert.equal(registry.active('google').version, 'test-v2')
  config.registrations[0].providerClientId = 'mutated'
  assert.equal(registry.resolve(row).providerClientId, 'google-test-client')
  assert.throws(() => registry.resolve({ ...row, returnTargetId: 'different' }), {
    code: 'AUTH_INTERNAL_ERROR'
  })
  assert.throws(() => registry.resolve({ ...row, providerConfigVersion: 'removed' }), {
    code: 'AUTH_INTERNAL_ERROR'
  })
  for (const callbackUrl of [
    'http://api.test.invalid/auth/callback/google',
    'https://u:p@api.test.invalid/auth/callback/google',
    'https://api.test.invalid/auth/callback/google#fragment',
    'https://api.test.invalid/auth/callback/google?x=1',
    'https://api.test.invalid/auth/callback/discord'
  ]) {
    const bad = registryConfiguration()
    bad.registrations[0].callbackUrl = callbackUrl
    assert.throws(() => new LoginRegistry(bad), { code: 'AUTH_INTERNAL_ERROR' })
  }
  for (const url of [
    'https://app.test.invalid/return',
    'ldb-test://u:p@login/complete',
    'ldb-test://login/complete?code=old',
    'ldb-test://login/complete#fragment',
    'ldb-test://*/complete'
  ]) {
    const bad = registryConfiguration()
    bad.registrations[0].returnTarget.url = url
    assert.throws(() => new LoginRegistry(bad), { code: 'AUTH_INTERNAL_ERROR' })
  }
})

test('provider PKCE encryption binds request/provider/purpose and supports retained keys', () => {
  const key = randomBytes(32)
  const oldKey = randomBytes(32)
  const keys = new crypto.ProviderPkceKeys({
    activeKeyId: 'new',
    keys: [
      { id: 'old', key: oldKey },
      { id: 'new', key }
    ]
  })
  const context = { id: randomUUID(), provider: 'google', purpose: 'login' }
  const verifier = opaque()
  const sealed = keys.encrypt(verifier, context)
  const historical = new crypto.ProviderPkceKeys({
    activeKeyId: 'old',
    keys: [{ id: 'old', key: oldKey }]
  }).encrypt(verifier, context)
  assert.equal(keys.decrypt({ ...context, ...historical }), verifier)
  assert.equal(sealed.providerPkceIv.length, 12)
  assert.equal(sealed.providerPkceTag.length, 16)
  assert.equal(sealed.providerPkceKeyId, 'new')
  assert.equal(keys.decrypt({ ...context, ...sealed }), verifier)
  assert.notDeepEqual(keys.encrypt(verifier, context).providerPkceIv, sealed.providerPkceIv)
  for (const patch of [
    { id: randomUUID() },
    { provider: 'discord' },
    { purpose: 'other' },
    { providerPkceTag: randomBytes(16) },
    { providerPkceKeyId: 'missing' }
  ]) {
    assert.throws(() => keys.decrypt({ ...context, ...sealed, ...patch }), {
      code: 'AUTH_INTERNAL_ERROR'
    })
  }
  assert.throws(() => new crypto.ProviderPkceKeys({ activeKeyId: 'x', keys: [] }), {
    code: 'AUTH_INTERNAL_ERROR'
  })
  assert.throws(
    () =>
      new crypto.ProviderPkceKeys({ activeKeyId: 'x', keys: [{ id: 'x', key: randomBytes(16) }] }),
    { code: 'AUTH_INTERNAL_ERROR' }
  )
})
