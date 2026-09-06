/* global Response */
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { createGoogleProviderVerifier } from '../dist/auth/google/index.js'
import { LoginFailure } from '../dist/errors/login.js'
import { LOGIN_ERRORS } from '../dist/constants/login.js'
import { opaque } from './login-fixtures.mjs'
import { settled } from './login-test-control.mjs'
import {
  adapterConfiguration, jwksUri, providerFailure, signingKey, tokenEndpoint, tokenResponse,
  verificationInput,
} from './google-fixtures.mjs'

const key = await signingKey('shared-google-key')
const rotated = await signingKey('shared-rotated-google-key')

async function concurrentFixture(tokenKeys, readKeys) {
  const inputs = tokenKeys.map(() => verificationInput())
  const responses = new Map()
  for (const [index, signer] of tokenKeys.entries()) {
    const input = inputs[index]
    input.input.code = opaque()
    responses.set(input.input.code, await tokenResponse(signer, input.nonce))
  }
  const requests = { token: [], keys: [] }
  const transport = adapterConfiguration(key, undefined, {
    fetch: async (url, options) => {
      const isTokenRequest = url === tokenEndpoint
      if (isTokenRequest) {
        requests.token.push(options)
        const response = responses.get(options.body.get('code'))
        const hasResponse = response != null
        assert(hasResponse)
        return Response.json(response)
      }
      assert.equal(url, jwksUri)
      requests.keys.push(options)
      return readKeys(requests.keys.length, options.signal)
    },
  })
  return { inputs, requests, verify: createGoogleProviderVerifier(transport.configuration) }
}

function assertIdentity(result) {
  const identity = result.value
  const hasIdentity = identity != null
  assert(hasIdentity)
  assert.deepEqual(Object.keys(identity).sort(), ['provider', 'subject'])
  assert.equal(identity.provider, 'google')
  const hasExpectedSubject = identity.subject === 'FixtureSubject'
  assert(hasExpectedSubject)
}

async function assertProviderRejection(result) {
  const error = result.error
  const hasError = error != null
  assert(hasError)
  await providerFailure(Promise.reject(error))
}

function assertTokenIsolation(fixture) {
  for (const [index, request] of fixture.requests.token.entries()) {
    const hasOriginalSignal = request.signal === fixture.inputs[index].input.signal
    const isFormReleased = request.body === undefined
    assert(hasOriginalSignal)
    assert(isFormReleased)
  }
}

test('cold and expired concurrent RS256 callbacks share one public JWKS load', async (t) => {
  for (const cacheState of ['cold', 'expired']) {
    await t.test(cacheState, async (caseTest) => {
      const isExpiredCache = cacheState === 'expired'
      const release = Promise.withResolvers()
      let clock = Date.now()
      caseTest.mock.method(Date, 'now', () => clock)
      const f = await concurrentFixture([key, key, key, key], (sequence) => {
        const isWarmup = isExpiredCache && sequence === 1
        if (isWarmup) return Response.json({ keys: [key.jwk] }, { headers: { 'cache-control': 'max-age=60' } })
        return release.promise
      })
      if (isExpiredCache) {
        assertIdentity(await settled(f.verify(f.inputs[0].input)))
        clock += 60_000
      }
      const beforeKeys = f.requests.keys.length
      const beforeTokens = f.requests.token.length
      const firstIndex = isExpiredCache ? 1 : 0
      const callers = f.inputs.slice(firstIndex)
      const pending = callers.map(({ input }) => settled(f.verify(input)))
      try {
        await setImmediate()
        assert.equal(f.requests.keys.length - beforeKeys, 1)
        assert.equal(f.requests.token.length - beforeTokens, callers.length)
        release.resolve(Response.json({ keys: [key.jwk] }, { headers: { 'cache-control': 'max-age=60' } }))
        for (const result of await Promise.all(pending)) assertIdentity(result)
        assertTokenIsolation(f)
      } finally {
        release.resolve(Response.json({ keys: [key.jwk] }))
        for (const caller of f.inputs) caller.controller.abort()
        await Promise.all(pending)
      }
    })
  }
})

test('concurrent unknown kids share the initial load and exactly one propagation refresh', async () => {
  const releaseRefresh = Promise.withResolvers()
  const f = await concurrentFixture([rotated, rotated, rotated], (sequence) => {
    const isInitialLoad = sequence === 1
    if (isInitialLoad) return Response.json({ keys: [key.jwk] }, { headers: { 'cache-control': 'max-age=60' } })
    return releaseRefresh.promise
  })
  const pending = f.inputs.map(({ input }) => settled(f.verify(input)))
  try {
    await setImmediate()
    assert.equal(f.requests.keys.length, 2)
    releaseRefresh.resolve(Response.json({ keys: [rotated.jwk] }, { headers: { 'cache-control': 'max-age=60' } }))
    for (const result of await Promise.all(pending)) assertIdentity(result)
    assert.equal(f.requests.keys.length, 2)
    assert.equal(f.requests.token.length, 3)
    assertTokenIsolation(f)
  } finally {
    releaseRefresh.resolve(Response.json({ keys: [rotated.jwk] }))
    for (const caller of f.inputs) caller.controller.abort()
    await Promise.all(pending)
  }
})

test('one caller cancellation leaves the shared fetch and remaining callback alive', async () => {
  const release = Promise.withResolvers()
  const f = await concurrentFixture([key, key], () => release.promise)
  const pending = f.inputs.map(({ input }) => settled(f.verify(input)))
  try {
    await setImmediate()
    assert.equal(f.requests.keys.length, 1)
    f.inputs[0].controller.abort(new Error('fixture-raw-error'))
    await assertProviderRejection(await pending[0])
    const isFetchAborted = f.requests.keys[0].signal.aborted
    const isOtherCallerAborted = f.inputs[1].input.signal.aborted
    assert.equal(isFetchAborted, false)
    assert.equal(isOtherCallerAborted, false)
    release.resolve(Response.json({ keys: [key.jwk] }))
    assertIdentity(await pending[1])
    assert.equal(f.requests.token.length, 2)
    assertTokenIsolation(f)
  } finally {
    release.resolve(Response.json({ keys: [key.jwk] }))
    for (const caller of f.inputs) caller.controller.abort()
    await Promise.all(pending)
  }
})

test('last waiter cancellation aborts shared headers/body and discards late responses', async (t) => {
  for (const stage of ['headers', 'body']) {
    await t.test(stage, async () => {
      const release = Promise.withResolvers()
      const isBodyStage = stage === 'body'
      let cancelledBodies = 0
      const response = {
        status: 200,
        headers: new Map([['cache-control', 'max-age=60']]),
        body: { cancel: async () => { cancelledBodies += 1 } },
        json: () => {
          if (isBodyStage) return release.promise
          return Promise.resolve({ keys: [key.jwk] })
        },
      }
      const f = await concurrentFixture([key, key], async () => {
        if (isBodyStage) return response
        return release.promise
      })
      const pending = f.inputs.map(({ input }) => settled(f.verify(input)))
      try {
        await setImmediate()
        assert.equal(f.requests.keys.length, 1)
        f.inputs[0].controller.abort()
        await assertProviderRejection(await pending[0])
        assert.equal(f.requests.keys[0].signal.aborted, false)
        f.inputs[1].controller.abort()
        await assertProviderRejection(await pending[1])
        assert.equal(f.requests.keys[0].signal.aborted, true)
        release.resolve(isBodyStage ? { keys: [key.jwk] } : response)
        await setImmediate()
        const wasBodyCancelled = cancelledBodies > 0
        assert(wasBodyCancelled)
        assertTokenIsolation(f)
      } finally {
        release.resolve(isBodyStage ? { keys: [key.jwk] } : response)
        for (const caller of f.inputs) caller.controller.abort()
        await Promise.all(pending)
      }
    })
  }
})

test('first cancellation closes new joins; old survivors finish without overwriting newer cache', async () => {
  const releaseOld = Promise.withResolvers()
  const f = await concurrentFixture([key, key, rotated, rotated], (sequence) => {
    const isOldGeneration = sequence === 1
    if (isOldGeneration) return releaseOld.promise
    return Response.json({ keys: [rotated.jwk] }, { headers: { 'cache-control': 'max-age=60' } })
  })
  const first = settled(f.verify(f.inputs[0].input))
  const survivor = settled(f.verify(f.inputs[1].input))
  try {
    await setImmediate()
    assert.equal(f.requests.keys.length, 1)
    f.inputs[0].controller.abort()
    await assertProviderRejection(await first)
    assert.equal(f.requests.keys[0].signal.aborted, false)
    assertIdentity(await settled(f.verify(f.inputs[2].input)))
    assert.equal(f.requests.keys.length, 2)
    releaseOld.resolve(Response.json({ keys: [key.jwk] }, { headers: { 'cache-control': 'max-age=60' } }))
    assertIdentity(await survivor)
    assertIdentity(await settled(f.verify(f.inputs[3].input)))
    assert.equal(f.requests.keys.length, 2)
    assertTokenIsolation(f)
  } finally {
    releaseOld.resolve(Response.json({ keys: [key.jwk] }))
    for (const caller of f.inputs) caller.controller.abort()
    await Promise.all([first, survivor])
  }
})

test('stale shared refresh only rechecks a newer fresh cache without another fetch', async (t) => {
  for (const cacheState of ['fresh', 'expired', 'absent', 'ambiguous']) {
    await t.test(cacheState, async (caseTest) => {
      const hasNewerGeneration = cacheState !== 'absent'
      const shouldExpireCache = cacheState === 'expired'
      const hasAmbiguousRefresh = cacheState === 'ambiguous'
      const canUseFreshCache = hasNewerGeneration && !shouldExpireCache && !hasAmbiguousRefresh
      const releaseOldRefresh = Promise.withResolvers()
      let clock = Date.now()
      caseTest.mock.method(Date, 'now', () => clock)
      const f = await concurrentFixture([key, rotated, rotated, rotated], (generation) => {
        const isWarmup = generation === 1
        if (isWarmup) return Response.json({ keys: [key.jwk] }, { headers: { 'cache-control': 'max-age=60' } })
        const isOldRefresh = generation === 2
        if (isOldRefresh) return releaseOldRefresh.promise
        return Response.json({ keys: [rotated.jwk] }, { headers: { 'cache-control': 'max-age=60' } })
      })
      assertIdentity(await settled(f.verify(f.inputs[0].input)))
      assert.equal(f.requests.keys.length, 1)
      assert.equal(f.requests.token.length, 1)

      const cancelledCaller = settled(f.verify(f.inputs[1].input))
      const survivor = settled(f.verify(f.inputs[2].input))
      try {
        await setImmediate()
        assert.equal(f.requests.keys.length, 2)
        f.inputs[1].controller.abort()
        await assertProviderRejection(await cancelledCaller)
        assert.equal(f.requests.keys[1].signal.aborted, false)
        if (hasNewerGeneration) {
          assertIdentity(await settled(f.verify(f.inputs[3].input)))
          assert.equal(f.requests.keys.length, 3)
        }
        if (shouldExpireCache) clock += 60_000
        const staleKeys = hasAmbiguousRefresh ? [rotated.jwk, rotated.jwk] : [key.jwk]
        releaseOldRefresh.resolve(Response.json({ keys: staleKeys }, {
          headers: { 'cache-control': 'max-age=60' },
        }))

        const survivorResult = await survivor
        if (canUseFreshCache) assertIdentity(survivorResult)
        else await assertProviderRejection(survivorResult)
        const expectedKeys = hasNewerGeneration ? 3 : 2
        const expectedTokens = hasNewerGeneration ? 4 : 3
        assert.equal(f.requests.keys.length, expectedKeys)
        assert.equal(f.requests.token.length, expectedTokens)
        assertTokenIsolation(f)
      } finally {
        releaseOldRefresh.resolve(Response.json({ keys: [key.jwk] }))
        for (const caller of f.inputs) caller.controller.abort()
        await Promise.all([cancelledCaller, survivor])
      }
    })
  }
})

test('external secret/token/body/JWKS errors cannot choose the adapter public error category', async () => {
  const f = verificationInput()
  const response = await tokenResponse(key, f.nonce)
  for (const stage of ['secret', 'token', 'body', 'JWKS']) {
    const isSecretStage = stage === 'secret'
    const isTokenStage = stage === 'token'
    const isBodyStage = stage === 'body'
    const isKeysStage = stage === 'JWKS'
    const fail = () => { throw new LoginFailure(LOGIN_ERRORS.INTERNAL) }
    const transport = adapterConfiguration(key, response, {
      resolveSecret: () => {
        if (isSecretStage) return fail()
        return 'fixture-client-secret'
      },
      fetch: async (url) => {
        const isTokenRequest = url === tokenEndpoint
        const shouldFailToken = isTokenRequest && isTokenStage
        const shouldFailKeys = !isTokenRequest && isKeysStage
        const shouldFailRequest = shouldFailToken || shouldFailKeys
        if (shouldFailRequest) return fail()
        const shouldFailBody = isTokenRequest && isBodyStage
        if (shouldFailBody) return { status: 200, body: null, json: fail }
        if (isTokenRequest) return Response.json(response)
        return Response.json({ keys: [key.jwk] })
      },
    })
    await providerFailure(createGoogleProviderVerifier(transport.configuration)(f.input))
  }
})
