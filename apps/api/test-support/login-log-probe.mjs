/* global fetch */
import assert from 'node:assert/strict'
import process from 'node:process'
import { createLoginHttpApp } from '../dist/auth/login/http.js'
import { opaque } from './login-fixtures.mjs'
import { LoginRegistry } from '../dist/auth/login/registry.js'
import { registryConfiguration } from './login-fixtures.mjs'

const stdout = process.stdout.write,
  stderr = process.stderr.write
const captured = []
const capture = (chunk, encoding, callback) => {
  captured.push(String(chunk))
  if (typeof encoding === 'function') {
    encoding()
  } else if (typeof callback === 'function') {
    callback()
  }
  return true
}
let app,
  failed = false
process.stdout.write = capture
process.stderr.write = capture
try {
  const invalidConfig = registryConfiguration()
  invalidConfig.registrations[0].callbackUrl = 'http://credential-canary.invalid/callback'
  assert.throws(
    () => new LoginRegistry(invalidConfig),
    (error) => {
      assert.equal(error.code, 'AUTH_INTERNAL_ERROR')
      assert.doesNotMatch(String(error.stack), /credential-canary/)
      return true
    }
  )
  let successful = false
  const fail = () => {
    throw new Error('credential-canary provider-subject nickname SQL secret')
  }
  app = await createLoginHttpApp(
    {
      create: fail,
      authorize: fail,
      exchange: () =>
        successful
          ? { accessToken: 'credential-canary', refreshToken: 'credential-canary' }
          : fail(),
      callback: () =>
        successful
          ? {
              returnUrl: `ldb-test://login/complete?code=${opaque()}`,
              cookie: '__Host-test=; Max-Age=0; Secure; HttpOnly; Path=/'
            }
          : fail()
    },
    {
      refresh: () =>
        successful
          ? {
              tokenType: 'Bearer',
              accessToken: 'credential-canary',
              accessTokenExpiresAt: '2026-09-06T00:15:00.000Z',
              refreshToken: 'credential-canary',
              sessionExpiresAt: '2026-10-06T00:00:00.000Z'
            }
          : fail(),
      logout: () => (successful ? undefined : fail())
    }
  )
  await app.listen(0, '127.0.0.1')
  const base = await app.getUrl()
  const callback = await fetch(
    `${base}/auth/callback/google?state=${opaque()}&code=credential-canary`,
    {
      headers: { cookie: 'credential-canary', authorization: 'Bearer credential-canary' },
      redirect: 'manual'
    }
  )
  assert.equal(callback.status, 500)
  assert.doesNotMatch(
    await callback.text(),
    /credential-canary|provider-subject|nickname|SQL|secret/
  )
  const malformed = await fetch(`${base}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"credential-canary":'
  })
  assert.equal(malformed.status, 400)
  assert.doesNotMatch(await malformed.text(), /credential-canary/)
  for (const [media, expected] of [
    ['application/json', 413],
    ['text/plain', 415]
  ]) {
    const rejected = await fetch(`${base}/auth/exchange`, {
      method: 'POST',
      headers: { 'content-type': media },
      body: 'credential-canary'.repeat(1100)
    })
    assert.equal(rejected.status, expected)
    assert.doesNotMatch(await rejected.text(), /credential-canary/)
  }
  for (const path of ['/auth/refresh', '/auth/logout']) {
    const failedSession = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: opaque() })
    })
    assert.equal(failedSession.status, 500)
    assert.doesNotMatch(
      await failedSession.text(),
      /credential-canary|provider-subject|nickname|SQL|secret/
    )
    const malformedSession = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"refreshToken":"credential-canary",'
    })
    assert.equal(malformedSession.status, 400)
    assert.doesNotMatch(await malformedSession.text(), /credential-canary|refreshToken/)
    const invalidShape = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: opaque(), sessionId: 'credential-canary' })
    })
    assert.equal(invalidShape.status, 400)
    assert.doesNotMatch(await invalidShape.text(), /credential-canary|sessionId|refreshToken/)
    for (const [media, expected] of [
      ['application/json', 413],
      ['text/plain', 415]
    ]) {
      const rejected = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': media },
        body: 'credential-canary'.repeat(1100)
      })
      assert.equal(rejected.status, expected)
      assert.doesNotMatch(await rejected.text(), /credential-canary/)
    }
  }
  successful = true
  const completion = await fetch(
    `${base}/auth/callback/google?state=${opaque()}&code=credential-canary`
  )
  assert.equal(completion.status, 200)
  assert.match(await completion.text(), /ldb-test:/)
  const tokens = await fetch(`${base}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: '00000000-0000-4000-8000-000000000000',
      clientId: 'desktop',
      code: opaque(),
      codeVerifier: opaque()
    })
  })
  assert.equal(tokens.status, 200)
  assert.equal((await tokens.json()).accessToken, 'credential-canary')
  const refreshed = await fetch(`${base}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: opaque() })
  })
  assert.equal(refreshed.status, 200)
  assert.equal((await refreshed.json()).refreshToken, 'credential-canary')
  const loggedOut = await fetch(`${base}/auth/logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: opaque() })
  })
  assert.equal(loggedOut.status, 204)
  assert.equal(await loggedOut.text(), '')
} catch {
  failed = true
} finally {
  try {
    await app?.close()
  } catch {
    failed = true
  }
  process.stdout.write = stdout
  process.stderr.write = stderr
}
if (failed || captured.length) {
  process.stderr.write('Login log probe failed\n')
  process.exitCode = 1
} else {
  process.stdout.write('Login log probe passed\n')
}
