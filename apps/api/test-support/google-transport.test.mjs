/* global Response */
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { createGoogleProviderVerifier } from '../dist/auth/google/index.js'
import { registration } from './login-fixtures.mjs'
import {
  adapterConfiguration, jwksUri, providerFailure, signingKey, tokenEndpoint, tokenResponse,
  verificationInput,
} from './google-fixtures.mjs'

const key = await signingKey()

test('historical version binds exact client, secret reference, callback, audience and trusted endpoints', async () => {
  const old = registration()
  const current = { ...registration('google', 'test-v2'), providerClientId: 'new-client',
    expectedAudience: 'new-client', providerSecretRef: 'new-secret-reference' }
  const f = verificationInput(old)
  const transport = adapterConfiguration(key, await tokenResponse(key, f.nonce), {
    registrations: [
      { snapshot: old, tokenEndpoint, jwksUri },
      { snapshot: current, tokenEndpoint: 'https://new-token.test.invalid/token', jwksUri },
    ],
  })
  const verify = createGoogleProviderVerifier(transport.configuration)
  // 호출자의 configuration mutation도 이미 복제한 historical binding을 바꾸지 않는다.
  transport.configuration.registrations[0].tokenEndpoint = 'https://mutated.test.invalid/token'
  await verify(f.input)
  assert.equal(transport.requests[0].url, tokenEndpoint)
  assert.equal(transport.secrets[0].reference, old.providerSecretRef)
  const before = transport.requests.length
  for (const change of [
    { version: 'removed' }, { providerSecretRef: current.providerSecretRef },
    { providerClientId: current.providerClientId }, { expectedAudience: current.expectedAudience },
    { callbackUrl: 'https://other.test.invalid/auth/callback/google' }, { provider: 'discord' },
  ]) {
    await providerFailure(verify({ ...f.input, snapshot: { ...old, ...change } }))
  }
  assert.equal(transport.requests.length, before)
})

test('listen-time trusted configuration errors are sanitized', async () => {
  const f = verificationInput()
  for (const url of ['http://keys.test.invalid/certs', 'https://user:fixture-client-secret@keys.test.invalid/certs',
    'https://keys.test.invalid/certs#fragment', 'https://keys.test.invalid/certs?untrusted=1']) {
    const transport = adapterConfiguration(key, await tokenResponse(key, f.nonce))
    transport.configuration.registrations[0].jwksUri = url
    assert.throws(() => createGoogleProviderVerifier(transport.configuration), (error) => {
      assert.equal(error.code, 'AUTH_INTERNAL_ERROR')
      assert(!/fixture-client-secret/.test(String(error.stack)))
      return true
    })
  }
})

test('public JWKS caches, rotates once for unknown kid and never follows token jku/x5u', async () => {
  const rotated = await signingKey('rotated-google-key')
  const unknown = await signingKey('unknown-google-key')
  const f = verificationInput()
  let response = await tokenResponse(key, f.nonce, {}, {
    jku: 'https://attacker.test.invalid/jwks', x5u: 'https://attacker.test.invalid/cert',
  })
  let keyRequests = 0
  let keys = [key.jwk]
  const transport = adapterConfiguration(key, response, {
    fetch: async (url, options) => {
      assert.equal(options.redirect, 'error')
      if (url === tokenEndpoint) return Response.json(response)
      assert.equal(url, jwksUri)
      keyRequests += 1
      return Response.json({ keys }, { headers: { 'cache-control': 'public, max-age=3600' } })
    },
  })
  const verify = createGoogleProviderVerifier(transport.configuration)
  await verify(f.input)
  await verify(f.input)
  assert.equal(keyRequests, 1)
  keys = [key.jwk, rotated.jwk]
  response = await tokenResponse(rotated, f.nonce)
  await verify(f.input)
  assert.equal(keyRequests, 2)
  await verify(f.input)
  assert.equal(keyRequests, 2)
  response = await tokenResponse(unknown, f.nonce)
  await providerFailure(verify(f.input))
  assert.equal(keyRequests, 3)
  const empty = createGoogleProviderVerifier(transport.configuration)
  await providerFailure(empty(f.input))
  assert.equal(keyRequests, 4, 'fresh unknown kid does not trigger a second fetch')
})

test('JWKS HTTP no-store/no-cache/expired age prevent stale cache reuse', async () => {
  const f = verificationInput()
  const response = await tokenResponse(key, f.nonce)
  for (const headers of [
    { 'cache-control': 'no-store, max-age=3600' },
    { 'cache-control': 'no-cache, max-age=3600' },
    { 'cache-control': 'max-age=60', age: '60' },
    { 'cache-control': 'max-age=0' },
    {},
  ]) {
    let keyRequests = 0
    const transport = adapterConfiguration(key, response, { fetch: async (url) => {
      if (url === tokenEndpoint) return Response.json(response)
      keyRequests += 1
      return Response.json({ keys: [key.jwk] }, { headers })
    } })
    const verify = createGoogleProviderVerifier(transport.configuration)
    await verify(f.input)
    await verify(f.input)
    assert.equal(keyRequests, 2)
  }
})

test('normal max-age is fresh before its boundary and reloads exactly at expiration', async (t) => {
  const f = verificationInput()
  const response = await tokenResponse(key, f.nonce)
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  let requests = 0
  const transport = adapterConfiguration(key, response, { fetch: async (url) => {
    if (url === tokenEndpoint) return Response.json(response)
    requests += 1
    return Response.json({ keys: [key.jwk] }, { headers: { 'cache-control': 'max-age=60', age: '10' } })
  } })
  const verify = createGoogleProviderVerifier(transport.configuration)
  await verify(f.input)
  clock += 49_999
  await verify(f.input)
  assert.equal(requests, 1)
  clock += 1
  await verify(f.input)
  assert.equal(requests, 2)
})

test('aborted old JWKS body cannot overwrite the newer rotated cache when it finishes late', async () => {
  const rotated = await signingKey('rotated-after-abort')
  const first = verificationInput()
  const next = verificationInput()
  let response = await tokenResponse(key, first.nonce)
  const entered = Promise.withResolvers()
  const lateBody = Promise.withResolvers()
  let keyRequests = 0
  const transport = adapterConfiguration(key, response, { fetch: async (url) => {
    if (url === tokenEndpoint) return Response.json(response)
    keyRequests += 1
    if (keyRequests > 1) return Response.json({ keys: [rotated.jwk] }, { headers: { 'cache-control': 'max-age=3600' } })
    return {
      status: 200, headers: new Map([['cache-control', 'max-age=3600']]),
      body: { cancel: async () => undefined },
      json: () => { entered.resolve(); return lateBody.promise },
    }
  } })
  const verify = createGoogleProviderVerifier(transport.configuration)
  const abandoned = providerFailure(verify(first.input))
  await entered.promise
  first.controller.abort()
  await abandoned
  response = await tokenResponse(rotated, next.nonce)
  await verify(next.input)
  lateBody.resolve({ keys: [key.jwk] })
  await setImmediate()
  await verify(next.input)
  assert.equal(keyRequests, 2)
})

test('single caller signal cancels secret, token headers/body and JWKS headers/body; late replies cannot succeed', async (t) => {
  for (const stage of ['secret', 'token headers', 'token body', 'JWKS headers', 'JWKS body']) {
    await t.test(stage, async () => {
      const f = verificationInput()
      const response = await tokenResponse(key, f.nonce)
      const entered = Promise.withResolvers()
      const late = Promise.withResolvers()
      const requests = []
      let cancelled = 0
      const bodyResponse = (value, blocked) => ({
        status: 200,
        headers: new Map([['cache-control', 'max-age=3600']]),
        body: { cancel: async () => { cancelled += 1 } },
        json: () => {
          if (!blocked) return Promise.resolve(value)
          entered.resolve()
          return late.promise
        },
      })
      const transport = adapterConfiguration(key, response, {
        resolveSecret: () => {
          if (stage !== 'secret') return 'fixture-client-secret'
          entered.resolve()
          return late.promise
        },
        fetch: (url, options) => {
          requests.push(options)
          const token = url === tokenEndpoint
          if (stage === (token ? 'token headers' : 'JWKS headers')) {
            entered.resolve()
            return late.promise
          }
          return Promise.resolve(bodyResponse(token ? response : { keys: [key.jwk] },
            stage === (token ? 'token body' : 'JWKS body')))
        },
      })
      const verify = createGoogleProviderVerifier(transport.configuration)
      const pending = providerFailure(verify(f.input))
      await entered.promise
      if (stage.startsWith('JWKS')) {
        assert(requests[0].body === undefined, 'token form is already released during JWKS wait')
      }
      f.controller.abort(new Error('fixture-raw-error'))
      await pending
      assert(requests.every((options) => options.signal === f.input.signal))
      assert(requests.every((options) => options.body === undefined))
      late.resolve(stage === 'secret' ? 'fixture-client-secret' : stage.endsWith('headers')
        ? bodyResponse(response, false) : response)
      await setImmediate()
      if (stage !== 'secret') assert(cancelled > 0)
    })
  }
})

test('pre-abort performs no external call; provider HTTP/JSON/raw errors never escape or retry', async () => {
  const f = verificationInput()
  const response = await tokenResponse(key, f.nonce)
  const transport = adapterConfiguration(key, response)
  f.controller.abort()
  await providerFailure(createGoogleProviderVerifier(transport.configuration)(f.input))
  assert.equal(transport.requests.length, 0)
  assert.equal(transport.secrets.length, 0)
  for (const upstream of [
    () => Promise.reject(new Error('fixture-raw-error')),
    () => Promise.resolve(new Response('fixture-raw-error', { status: 500 })),
    () => Promise.resolve(new Response('fixture-raw-error', { status: 302, headers: { location: jwksUri } })),
    () => Promise.resolve(new Response('fixture-raw-error', { status: 200 })),
    () => Promise.resolve(Response.json({ error: 'fixture-raw-error' })),
  ]) {
    const next = verificationInput()
    let calls = 0
    const invalid = adapterConfiguration(key, response, { fetch: () => { calls += 1; return upstream() } })
    await providerFailure(createGoogleProviderVerifier(invalid.configuration)(next.input))
    assert.equal(calls, 1)
  }
})

test('missing historical secret and malformed trusted JWKS fail without retry or identity', async () => {
  const f = verificationInput()
  const response = await tokenResponse(key, f.nonce)
  for (const resolveSecret of [() => '', () => undefined, () => { throw new Error('fixture-raw-error') }]) {
    const invalid = adapterConfiguration(key, response, { resolveSecret })
    await providerFailure(createGoogleProviderVerifier(invalid.configuration)(f.input))
    assert.equal(invalid.requests.length, 0)
  }
  for (const keys of [null, [], { keys: [] }, { keys: ['invalid'] }, { keys: [{ kty: 'RSA', n: 'broken', e: 'AQAB' }] }]) {
    let calls = 0
    const invalid = adapterConfiguration(key, response, { fetch: async (url) => {
      calls += 1
      return Response.json(url === tokenEndpoint ? response : keys)
    } })
    await providerFailure(createGoogleProviderVerifier(invalid.configuration)(f.input))
    assert.equal(calls, 2)
  }
})
