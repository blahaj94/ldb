/* global fetch */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { request } from 'node:http'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createLoginHttpApp } from '../dist/auth/login/http.js'
import { REFRESH_ERRORS, RefreshFailure } from '../dist/auth/refresh/errors.js'
import { opaque } from './login-fixtures.mjs'

let app
let base
let loginCalls = 0
const sessionCalls = { refresh: [], logout: [] }
let refreshFailure
let logoutFailure

const loginService = {
  create: async () => {
    loginCalls++
    return {
      requestId: randomUUID(),
      browserUrl: 'https://api.test.invalid/auth/login/authorize?ticket=test',
      expiresAt: '2026-09-06T00:00:00.000Z',
    }
  },
  exchange: async () => {
    loginCalls++
    return { tokenType: 'Bearer', accessToken: 'login-access', refreshToken: 'login-refresh' }
  },
  authorize: async () => {
    loginCalls++
    return {
      redirectUrl: 'https://google.test.invalid/authorize?state=test',
      cookie: '__Host-test=x; Secure; HttpOnly; SameSite=Lax; Path=/',
    }
  },
  callback: async () => {
    loginCalls++
    return {
      returnUrl: 'ldb-test://login/complete?code=exchange-only',
      cookie: '__Host-test=; Max-Age=0; Secure; HttpOnly; SameSite=Lax; Path=/',
    }
  },
}

const sessionService = {
  refresh: async (rawToken) => {
    sessionCalls.refresh.push(rawToken)
    const hasRefreshFailure = refreshFailure != null
    if (hasRefreshFailure) throw refreshFailure
    return {
      tokenType: 'Bearer',
      accessToken: 'session-access',
      accessTokenExpiresAt: '2026-09-06T00:15:00.000Z',
      refreshToken: 'session-refresh',
      sessionExpiresAt: '2026-10-06T00:00:00.000Z',
    }
  },
  logout: async (rawToken) => {
    sessionCalls.logout.push(rawToken)
    const hasLogoutFailure = logoutFailure != null
    if (hasLogoutFailure) throw logoutFailure
  },
}

before(async () => {
  app = await createLoginHttpApp(loginService, sessionService)
  await app.listen(0, '127.0.0.1')
  base = await app.getUrl()
})

after(async () => {
  await app?.close()
})

function post(path, chunks, headers = {}) {
  return new Promise((resolve, reject) => {
    const httpRequest = request(
      `${base}${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        const body = []
        response.on('data', (part) => body.push(part))
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(body).toString('utf8'),
          })
        })
      },
    )
    httpRequest.on('error', reject)
    for (const chunk of chunks) httpRequest.write(chunk)
    httpRequest.end()
  })
}

test('refresh and logout accept only refreshToken and return no-store success responses', async () => {
  const refreshToken = opaque()
  const refreshed = await post('/auth/refresh', [JSON.stringify({ refreshToken })])
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(refreshed.body), {
    tokenType: 'Bearer',
    accessToken: 'session-access',
    accessTokenExpiresAt: '2026-09-06T00:15:00.000Z',
    refreshToken: 'session-refresh',
    sessionExpiresAt: '2026-10-06T00:00:00.000Z',
  })
  assert.deepEqual(sessionCalls.refresh, [refreshToken])

  const loggedOut = await post('/auth/logout', [JSON.stringify({ refreshToken })])
  assert.equal(loggedOut.status, 204)
  assert.equal(loggedOut.headers['cache-control'], 'no-store')
  assert.equal(loggedOut.body, '')
  assert.deepEqual(sessionCalls.logout, [refreshToken])
})

test('session routes apply media, size, UTF-8, JSON and exact-shape precedence before service', async () => {
  const baseline = {
    login: loginCalls,
    refresh: sessionCalls.refresh.length,
    logout: sessionCalls.logout.length,
  }
  for (const path of ['/auth/refresh', '/auth/logout']) {
    for (const [chunks, headers, status, code] of [
      [[Buffer.alloc(17_000)], { 'content-type': 'text/plain' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [[Buffer.alloc(17_000)], { 'content-encoding': 'gzip' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [[Buffer.alloc(8_000), Buffer.alloc(8_385)], {}, 413, 'REQUEST_TOO_LARGE'],
      [[Buffer.alloc(16_384, 'x')], {}, 400, 'INVALID_AUTH_REQUEST'],
      [[Buffer.from([0xff])], {}, 400, 'INVALID_AUTH_REQUEST'],
      [[], {}, 400, 'INVALID_AUTH_REQUEST'],
      [['{'], {}, 400, 'INVALID_AUTH_REQUEST'],
      [['null'], {}, 400, 'INVALID_AUTH_REQUEST'],
      [['[]'], {}, 400, 'INVALID_AUTH_REQUEST'],
      [['{}'], {}, 400, 'INVALID_AUTH_REQUEST'],
      [[JSON.stringify({ refreshToken: opaque(), sessionId: randomUUID() })], {}, 400, 'INVALID_AUTH_REQUEST'],
      [[JSON.stringify({ refreshToken: 1 })], {}, 400, 'INVALID_AUTH_REQUEST'],
    ]) {
      const response = await post(path, chunks, headers)
      assert.equal(response.status, status)
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(JSON.parse(response.body).error.code, code)
      const isTooLarge = status === 413
      if (isTooLarge) assert.equal(response.headers.connection, 'close')
    }
  }
  assert.deepEqual(
    {
      login: loginCalls,
      refresh: sessionCalls.refresh.length,
      logout: sessionCalls.logout.length,
    },
    baseline,
  )
})

test('session routes accept exactly 16,384 UTF-8 bytes and reject the next byte', async () => {
  for (const path of ['/auth/refresh', '/auth/logout']) {
    const prefix = '{"refreshToken":"'
    const suffix = '"}'
    const atLimit = prefix + 'x'.repeat(16_384 - prefix.length - suffix.length) + suffix
    assert.equal(Buffer.byteLength(atLimit), 16_384)
    const accepted = await post(path, [atLimit.slice(0, 8_000), atLimit.slice(8_000)], {
      'content-type': 'application/json; charset="utf-8"',
      'content-encoding': 'identity',
    })
    const isLogoutPath = path.endsWith('logout')
    const expectedStatus = isLogoutPath ? 204 : 200
    assert.equal(accepted.status, expectedStatus)

    const rejected = await post(path, [atLimit, ' '])
    assert.equal(rejected.status, 413)
    assert.equal(JSON.parse(rejected.body).error.code, 'REQUEST_TOO_LARGE')
  }
})

test('refresh preserves every explicit RefreshFailure and sanitizes unknown failures', async () => {
  try {
    for (const definition of [
      REFRESH_ERRORS.INVALID_REQUEST,
      REFRESH_ERRORS.AUTHENTICATION_REQUIRED,
      REFRESH_ERRORS.INTERNAL,
      REFRESH_ERRORS.UNAVAILABLE,
    ]) {
      refreshFailure = new RefreshFailure(definition)
      const response = await post('/auth/refresh', [JSON.stringify({ refreshToken: opaque() })])
      assert.equal(response.status, definition.status)
      assert.deepEqual(JSON.parse(response.body), {
        error: { code: definition.code, message: definition.message },
      })
    }
    refreshFailure = new Error('raw credential identity SQL https://private.invalid')
    const internal = await post('/auth/refresh', [JSON.stringify({ refreshToken: opaque() })])
    assert.equal(internal.status, 500)
    assert.deepEqual(JSON.parse(internal.body), {
      error: {
        code: 'AUTH_INTERNAL_ERROR',
        message: '인증 요청을 처리하지 못했습니다.',
      },
    })
    assert.doesNotMatch(internal.body, /raw|credential|identity|SQL|private/)
  } finally {
    refreshFailure = undefined
  }
})

test('logout never emits a success 204 when its result is unavailable', async () => {
  try {
    logoutFailure = new RefreshFailure(REFRESH_ERRORS.UNAVAILABLE)
    const response = await post('/auth/logout', [JSON.stringify({ refreshToken: opaque() })])
    assert.equal(response.status, 503)
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        code: 'AUTH_UNAVAILABLE',
        message: '현재 계정 기능을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
      },
    })
  } finally {
    logoutFailure = undefined
  }
})

test('adding session routes preserves login and HEAD behavior', async () => {
  const refreshBefore = sessionCalls.refresh.length
  const logoutBefore = sessionCalls.logout.length
  const head = await fetch(`${base}/auth/login/authorize?ticket=${opaque()}`, {
    method: 'HEAD',
    redirect: 'manual',
  })
  assert.equal(head.status, 400)
  assert.equal(head.headers.get('cache-control'), 'no-store')
  assert.equal(await head.text(), '')

  const get = await fetch(`${base}/auth/login/authorize?ticket=${opaque()}`, {
    redirect: 'manual',
  })
  assert.equal(get.status, 303)
  assert.equal(get.headers.get('cache-control'), 'no-store')
  assert.equal(sessionCalls.refresh.length, refreshBefore)
  assert.equal(sessionCalls.logout.length, logoutBefore)
})
