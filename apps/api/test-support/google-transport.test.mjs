import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { createGoogleProviderVerifier } from '../dist/auth/google/index.js'
import { withAbort } from '../dist/auth/google/transport.js'
import { registration } from './login-fixtures.mjs'
import {
  adapterConfiguration,
  jwksUri,
  providerFailure,
  signingKey,
  tokenEndpoint,
  tokenResponse,
  verificationInput
} from './google-fixtures.mjs'

const key = await signingKey()

test('late fulfillment after abort skips a second signal read and discards in order', async () => {
  const operation = Promise.withResolvers()
  const trace = []
  let abortListener
  let abortedReads = 0
  const signal = {
    addEventListener(type, listener) {
      assert.equal(type, 'abort')
      abortListener = listener
      trace.push('add')
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort')
      assert.equal(listener, abortListener)
      trace.push('remove')
    },
    get aborted() {
      abortedReads += 1
      trace.push('aborted')
      return false
    }
  }
  const value = { late: true }
  const pending = withAbort(operation.promise, signal, (discarded) => {
    assert.equal(discarded, value)
    trace.push('discard')
  })

  abortListener()
  await providerFailure(pending)
  operation.resolve(value)
  await setImmediate()

  assert.equal(abortedReads, 1)
  assert.deepEqual(trace, ['add', 'aborted', 'remove', 'remove', 'discard'])
})

test('reentrant abort during fulfillment read rejects and discards the same value', async () => {
  const operation = Promise.withResolvers()
  const trace = []
  let abortListener
  let abortedReads = 0
  const signal = {
    addEventListener(type, listener) {
      assert.equal(type, 'abort')
      abortListener = listener
      trace.push('add')
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort')
      assert.equal(listener, abortListener)
      trace.push('remove')
    },
    get aborted() {
      abortedReads += 1
      trace.push('aborted')
      const isFulfillmentRead = abortedReads === 2
      if (isFulfillmentRead) {
        trace.push('abort')
        abortListener()
      }
      return false
    }
  }
  const value = { reentrant: true }
  const pending = withAbort(operation.promise, signal, (discarded) => {
    assert.equal(discarded, value)
    trace.push('discard')
  })

  operation.resolve(value)
  await providerFailure(pending)
  await setImmediate()

  assert.equal(abortedReads, 2)
  assert.deepEqual(trace, ['add', 'aborted', 'remove', 'aborted', 'abort', 'remove', 'discard'])
})

test('historical version binds exact client, secret reference, callback, audience and trusted endpoints', async () => {
  const old = registration()
  const current = {
    ...registration('google', 'test-v2'),
    providerClientId: 'new-client',
    expectedAudience: 'new-client',
    providerSecretRef: 'new-secret-reference'
  }
  const f = verificationInput(old)
  const transport = adapterConfiguration(key, await tokenResponse(key, f.nonce), {
    registrations: [
      { snapshot: old, tokenEndpoint, jwksUri },
      { snapshot: current, tokenEndpoint: 'https://new-token.test.invalid/token', jwksUri }
    ]
  })
  const verify = createGoogleProviderVerifier(transport.configuration)
  // 호출자의 configuration mutation도 이미 복제한 historical binding을 바꾸지 않는다.
  transport.configuration.registrations[0].tokenEndpoint = 'https://mutated.test.invalid/token'
  await verify(f.input)
  assert.equal(transport.requests[0].url, tokenEndpoint)
  assert.equal(transport.secrets[0].reference, old.providerSecretRef)
  const before = transport.requests.length
  for (const change of [
    { version: 'removed' },
    { providerSecretRef: current.providerSecretRef },
    { providerClientId: current.providerClientId },
    { expectedAudience: current.expectedAudience },
    { callbackUrl: 'https://other.test.invalid/auth/callback/google' },
    { provider: 'discord' }
  ]) {
    await providerFailure(verify({ ...f.input, snapshot: { ...old, ...change } }))
  }
  assert.equal(transport.requests.length, before)
})

test('listen-time trusted configuration errors are sanitized', async () => {
  const f = verificationInput()
  for (const url of [
    'http://keys.test.invalid/certs',
    'https://user:fixture-client-secret@keys.test.invalid/certs',
    'https://keys.test.invalid/certs#fragment',
    'https://keys.test.invalid/certs?untrusted=1'
  ]) {
    const transport = adapterConfiguration(key, await tokenResponse(key, f.nonce))
    transport.configuration.registrations[0].jwksUri = url
    assert.throws(
      () => createGoogleProviderVerifier(transport.configuration),
      (error) => {
        assert.equal(error.code, 'AUTH_INTERNAL_ERROR')
        const leaksSecret = /fixture-client-secret/.test(String(error.stack))
        assert.equal(leaksSecret, false)
        return true
      }
    )
  }
})

test('public JWKS caches, rotates once for unknown kid and never follows token jku/x5u', async () => {
  const rotated = await signingKey('rotated-google-key')
  const unknown = await signingKey('unknown-google-key')
  const f = verificationInput()
  let response = await tokenResponse(
    key,
    f.nonce,
    {},
    {
      jku: 'https://attacker.test.invalid/jwks',
      x5u: 'https://attacker.test.invalid/cert'
    }
  )
  let keyRequests = 0
  let keys = [key.jwk]
  const transport = adapterConfiguration(key, response, {
    fetch: async (url, options) => {
      assert.equal(options.redirect, 'error')
      const isTokenRequest = url === tokenEndpoint
      if (isTokenRequest) {
        return Response.json(response)
      }
      assert.equal(url, jwksUri)
      keyRequests += 1
      return Response.json({ keys }, { headers: { 'cache-control': 'public, max-age=3600' } })
    }
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
  assert.equal(
    keyRequests,
    5,
    'cold unknown kid performs one initial fetch and one bounded refresh'
  )
})

test('cold and expired JWKS each refresh once to verify a newly propagated RS256 key', async (t) => {
  const rotated = await signingKey('propagated-google-key')
  for (const initialCache of ['cold', 'expired']) {
    await t.test(initialCache, async (caseTest) => {
      const f = verificationInput()
      let clock = Date.now()
      caseTest.mock.method(Date, 'now', () => clock)
      let response = await tokenResponse(key, f.nonce)
      let tokenRequests = 0
      let keyRequests = 0
      let rotationStartedAt = 0
      let rotating = false
      const signals = []
      const transport = adapterConfiguration(key, response, {
        fetch: async (url, options) => {
          signals.push({ url, signal: options.signal })
          const isTokenRequest = url === tokenEndpoint
          if (isTokenRequest) {
            tokenRequests += 1
            return Response.json(response)
          }
          assert.equal(url, jwksUri)
          keyRequests += 1
          const isSecondFetch = keyRequests - rotationStartedAt === 2
          const hasPropagatedKey = rotating && isSecondFetch
          return Response.json(
            { keys: [hasPropagatedKey ? rotated.jwk : key.jwk] },
            {
              headers: { 'cache-control': 'max-age=60' }
            }
          )
        }
      })
      const verify = createGoogleProviderVerifier(transport.configuration)
      const isExpiredCache = initialCache === 'expired'
      if (isExpiredCache) {
        await verify(f.input)
        clock += 60_000
      }
      rotationStartedAt = keyRequests
      const previousTokenRequests = tokenRequests
      rotating = true
      response = await tokenResponse(rotated, f.nonce)

      const identity = await verify(f.input)

      const hasGoogleProvider = identity.provider === 'google'
      const hasExpectedSubject = identity.subject === 'FixtureSubject'
      const hasExpectedIdentity = hasGoogleProvider && hasExpectedSubject
      assert(hasExpectedIdentity)
      assert.equal(keyRequests - rotationStartedAt, 2)
      assert.equal(tokenRequests - previousTokenRequests, 1)
      const hasExpectedSignals = signals.every(({ url, signal }) => {
        const isTokenRequest = url === tokenEndpoint
        const hasOriginalSignal = signal === f.input.signal
        const isUnabortedKeySignal = !isTokenRequest && !signal.aborted
        const isExpectedSignal = isTokenRequest ? hasOriginalSignal : isUnabortedKeySignal
        return isExpectedSignal
      })
      assert(hasExpectedSignals)
    })
  }
})

test('persistent cold unknown kid stops after two JWKS fetches and never repeats token exchange', async () => {
  const unknown = await signingKey('never-propagated-google-key')
  const f = verificationInput()
  const response = await tokenResponse(unknown, f.nonce)
  let tokenRequests = 0
  let keyRequests = 0
  const transport = adapterConfiguration(key, response, {
    fetch: async (url) => {
      const isTokenRequest = url === tokenEndpoint
      if (isTokenRequest) {
        tokenRequests += 1
        return Response.json(response)
      }
      keyRequests += 1
      return Response.json({ keys: [key.jwk] })
    }
  })

  await providerFailure(createGoogleProviderVerifier(transport.configuration)(f.input))

  assert.equal(tokenRequests, 1)
  assert.equal(keyRequests, 2)
})

test('unknown kid refresh follows caller cancellation and drops an aborted late second response', async () => {
  const rotated = await signingKey('late-propagated-google-key')
  const f = verificationInput()
  const response = await tokenResponse(rotated, f.nonce)
  const refreshEntered = Promise.withResolvers()
  const lateRefresh = Promise.withResolvers()
  let keyRequests = 0
  let tokenRequests = 0
  const signals = []
  const transport = adapterConfiguration(key, response, {
    fetch: async (url, options) => {
      signals.push(options.signal)
      const isTokenRequest = url === tokenEndpoint
      if (isTokenRequest) {
        tokenRequests += 1
        return Response.json(response)
      }
      keyRequests += 1
      const isInitialLoad = keyRequests === 1
      if (isInitialLoad) {
        return Response.json({ keys: [key.jwk] })
      }
      refreshEntered.resolve()
      return lateRefresh.promise
    }
  })
  const pending = createGoogleProviderVerifier(transport.configuration)(f.input)
  const reachedRefresh = await Promise.race([
    refreshEntered.promise.then(() => true),
    pending.then(
      () => false,
      () => false
    )
  ])
  assert(reachedRefresh, 'unknown kid must reach its bounded refresh')
  f.controller.abort()
  await providerFailure(pending)
  lateRefresh.resolve(Response.json({ keys: [rotated.jwk] }))
  await setImmediate()
  assert.equal(tokenRequests, 1)
  assert.equal(keyRequests, 2)
  const hasOriginalTokenSignal = signals[0] === f.input.signal
  const isRefreshSignalAborted = signals.at(-1).aborted
  assert(hasOriginalTokenSignal)
  assert(isRefreshSignalAborted)
})

test('network failure during unknown kid refresh does not trigger another attempt', async () => {
  const unknown = await signingKey('unavailable-propagated-google-key')
  const f = verificationInput()
  const response = await tokenResponse(unknown, f.nonce)
  let keyRequests = 0
  let tokenRequests = 0
  const transport = adapterConfiguration(key, response, {
    fetch: async (url) => {
      const isTokenRequest = url === tokenEndpoint
      if (isTokenRequest) {
        tokenRequests += 1
        return Response.json(response)
      }
      keyRequests += 1
      const isInitialLoad = keyRequests === 1
      if (isInitialLoad) {
        return Response.json({ keys: [key.jwk] })
      }
      throw new Error('fixture-raw-error')
    }
  })

  await providerFailure(createGoogleProviderVerifier(transport.configuration)(f.input))

  assert.equal(tokenRequests, 1)
  assert.equal(keyRequests, 2)
})

test('JWKS HTTP no-store/no-cache/expired age prevent stale cache reuse', async () => {
  const f = verificationInput()
  const response = await tokenResponse(key, f.nonce)
  for (const headers of [
    { 'cache-control': 'no-store, max-age=3600' },
    { 'cache-control': 'no-cache, max-age=3600' },
    { 'cache-control': 'max-age=60', age: '60' },
    { 'cache-control': 'max-age=0' },
    {}
  ]) {
    let keyRequests = 0
    const transport = adapterConfiguration(key, response, {
      fetch: async (url) => {
        const isTokenRequest = url === tokenEndpoint
        if (isTokenRequest) {
          return Response.json(response)
        }
        keyRequests += 1
        return Response.json({ keys: [key.jwk] }, { headers })
      }
    })
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
  const transport = adapterConfiguration(key, response, {
    fetch: async (url) => {
      const isTokenRequest = url === tokenEndpoint
      if (isTokenRequest) {
        return Response.json(response)
      }
      requests += 1
      return Response.json(
        { keys: [key.jwk] },
        { headers: { 'cache-control': 'max-age=60', age: '10' } }
      )
    }
  })
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
  const transport = adapterConfiguration(key, response, {
    fetch: async (url) => {
      const isTokenRequest = url === tokenEndpoint
      if (isTokenRequest) {
        return Response.json(response)
      }
      keyRequests += 1
      const isNewGeneration = keyRequests > 1
      if (isNewGeneration) {
        return Response.json(
          { keys: [rotated.jwk] },
          { headers: { 'cache-control': 'max-age=3600' } }
        )
      }
      return {
        status: 200,
        headers: new Map([['cache-control', 'max-age=3600']]),
        body: { cancel: async () => undefined },
        json: () => {
          entered.resolve()
          return lateBody.promise
        }
      }
    }
  })
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
      const isSecretStage = stage === 'secret'
      const isJwksStage = stage.startsWith('JWKS')
      const isHeaderStage = stage.endsWith('headers')
      const f = verificationInput()
      const response = await tokenResponse(key, f.nonce)
      const entered = Promise.withResolvers()
      const late = Promise.withResolvers()
      const requests = []
      let cancelled = 0
      const bodyResponse = (value, blocked) => ({
        status: 200,
        headers: new Map([['cache-control', 'max-age=3600']]),
        body: {
          cancel: async () => {
            cancelled += 1
          }
        },
        json: () => {
          if (!blocked) {
            return Promise.resolve(value)
          }
          entered.resolve()
          return late.promise
        }
      })
      const transport = adapterConfiguration(key, response, {
        resolveSecret: () => {
          if (!isSecretStage) {
            return 'fixture-client-secret'
          }
          entered.resolve()
          return late.promise
        },
        fetch: (url, options) => {
          requests.push(options)
          const isTokenRequest = url === tokenEndpoint
          const headerStage = isTokenRequest ? 'token headers' : 'JWKS headers'
          const shouldHoldHeaders = stage === headerStage
          if (shouldHoldHeaders) {
            entered.resolve()
            return late.promise
          }
          const body = isTokenRequest ? response : { keys: [key.jwk] }
          const bodyStage = isTokenRequest ? 'token body' : 'JWKS body'
          const shouldHoldBody = stage === bodyStage
          return Promise.resolve(bodyResponse(body, shouldHoldBody))
        }
      })
      const verify = createGoogleProviderVerifier(transport.configuration)
      const pending = providerFailure(verify(f.input))
      await entered.promise
      if (isJwksStage) {
        const isFormReleased = requests[0].body === undefined
        assert(isFormReleased, 'token form is already released during JWKS wait')
      }
      f.controller.abort(new Error('fixture-raw-error'))
      await pending
      const hasTokenRequest = requests.length > 0
      if (hasTokenRequest) {
        const hasOriginalTokenSignal = requests[0].signal === f.input.signal
        assert(hasOriginalTokenSignal)
      }
      if (isJwksStage) {
        assert.equal(requests[1].signal.aborted, true)
      }
      const areFormsReleased = requests.every((options) => {
        const isFormReleased = options.body === undefined
        return isFormReleased
      })
      assert(areFormsReleased)
      let lateResult = response
      if (isSecretStage) {
        lateResult = 'fixture-client-secret'
      } else if (isHeaderStage) {
        lateResult = bodyResponse(response, false)
      }
      late.resolve(lateResult)
      await setImmediate()
      const wasBodyCancelled = cancelled > 0
      if (!isSecretStage) {
        assert(wasBodyCancelled)
      }
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
    () =>
      Promise.resolve(
        new Response('fixture-raw-error', { status: 302, headers: { location: jwksUri } })
      ),
    () => Promise.resolve(new Response('fixture-raw-error', { status: 200 })),
    () => Promise.resolve(Response.json({ error: 'fixture-raw-error' }))
  ]) {
    const next = verificationInput()
    let calls = 0
    const invalid = adapterConfiguration(key, response, {
      fetch: () => {
        calls += 1
        return upstream()
      }
    })
    await providerFailure(createGoogleProviderVerifier(invalid.configuration)(next.input))
    assert.equal(calls, 1)
  }
})

test('missing historical secret and malformed trusted JWKS fail without retry or identity', async () => {
  const f = verificationInput()
  const response = await tokenResponse(key, f.nonce)
  for (const resolveSecret of [
    () => '',
    () => undefined,
    () => {
      throw new Error('fixture-raw-error')
    }
  ]) {
    const invalid = adapterConfiguration(key, response, { resolveSecret })
    await providerFailure(createGoogleProviderVerifier(invalid.configuration)(f.input))
    assert.equal(invalid.requests.length, 0)
  }
  for (const [keys, expectedRequests] of [
    [null, 2],
    [[], 2],
    [{ keys: [] }, 3],
    [{ keys: ['invalid'] }, 2],
    [{ keys: [{ kty: 'RSA', n: 'broken', e: 'AQAB' }] }, 3]
  ]) {
    let calls = 0
    const invalid = adapterConfiguration(key, response, {
      fetch: async (url) => {
        calls += 1
        const isTokenRequest = url === tokenEndpoint
        return Response.json(isTokenRequest ? response : keys)
      }
    })
    await providerFailure(createGoogleProviderVerifier(invalid.configuration)(f.input))
    assert.equal(calls, expectedRequests)
  }
})
