import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGoogleJwks } from '../dist/auth/google/jwks.js'
import { createGoogleProviderVerifier } from '../dist/auth/google/index.js'
import {
  adapterConfiguration,
  jwksUri,
  providerFailure,
  signingKey,
  tokenResponse,
  verificationInput
} from './google-fixtures.mjs'

const key = await signingKey('condition-boundary-google-key')

test('cold JWKS does not evaluate cache freshness before its first load', async (t) => {
  let nowReads = 0
  t.mock.method(Date, 'now', () => {
    nowReads++
    return 1_000_000
  })
  let keyRequests = 0
  const resolveKey = createGoogleJwks(jwksUri, async () => {
    keyRequests++
    return Response.json({ keys: [key.jwk] }, { headers: { 'cache-control': 'max-age=60' } })
  })

  await resolveKey({ alg: 'RS256', kid: key.kid }, undefined, new AbortController().signal)

  assert.equal(keyRequests, 1)
  assert.equal(nowReads, 2)
})

test('unknown kid does not evaluate freshness for a cache with no newer generation', async (t) => {
  let nowReads = 0
  t.mock.method(Date, 'now', () => {
    nowReads++
    return 1_000_000
  })
  let keyRequests = 0
  const resolveKey = createGoogleJwks(jwksUri, async () => {
    keyRequests++
    return Response.json({ keys: [key.jwk] }, { headers: { 'cache-control': 'max-age=60' } })
  })

  await resolveKey({ alg: 'RS256', kid: key.kid }, undefined, new AbortController().signal)
  await providerFailure(
    resolveKey(
      { alg: 'RS256', kid: 'missing-condition-boundary-key' },
      undefined,
      new AbortController().signal
    )
  )

  assert.equal(keyRequests, 2)
  assert.equal(nowReads, 5)
})

test('missing Google registration does not inspect snapshot fields after version lookup', async () => {
  const f = verificationInput()
  const transport = adapterConfiguration(key, await tokenResponse(key, f.nonce))
  const verify = createGoogleProviderVerifier(transport.configuration)
  const reads = []
  const snapshot = new Proxy(
    { ...f.input.snapshot, version: 'missing-condition-boundary-version' },
    {
      get(target, property, receiver) {
        reads.push(String(property))
        return Reflect.get(target, property, receiver)
      }
    }
  )

  await providerFailure(verify({ ...f.input, snapshot }))

  assert.deepEqual(reads, ['version'])
  assert.equal(transport.requests.length, 0)
  assert.equal(transport.secrets.length, 0)
})
