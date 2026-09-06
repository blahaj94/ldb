/* global fetch */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { request } from 'node:http'
import process from 'node:process'
import { createLoginHttpApp, createSessionHttpService } from '../dist/auth/login/http.js'
import { opaque } from './login-fixtures.mjs'
import { bounded, instrument, settled } from './login-test-control.mjs'
import { digest, fixture, stored } from './refresh-fixtures.mjs'

const unavailableBody = {
  error: {
    code: 'AUTH_UNAVAILABLE',
    message: '현재 계정 기능을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  },
}

const loginService = {
  create: async () => {
    throw new Error('login is outside this scenario')
  },
  authorize: async () => {
    throw new Error('login is outside this scenario')
  },
  callback: async () => {
    throw new Error('login is outside this scenario')
  },
  exchange: async () => {
    throw new Error('login is outside this scenario')
  },
}

function post(base, path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function postChunks(base, path, chunks, headers = {}) {
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

async function withSessionApp(f, operation) {
  const app = await createLoginHttpApp(loginService, createSessionHttpService(f.deps))
  await app.listen(0, '127.0.0.1')
  try {
    return await operation(await app.getUrl())
  } finally {
    await app.close()
  }
}

async function expectAuthenticationRequired(response) {
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).error.code, 'AUTHENTICATION_REQUIRED')
}

async function normalRefreshAndLogout(source) {
  const f = await fixture(source)
  const otherDevice = await fixture(source, f.identity)
  const otherBefore = await stored(source, otherDevice.initial.session.id)
  const sessionBefore = await stored(source, f.initial.session.id)

  await withSessionApp(f, async (base) => {
    const refreshed = await post(base, '/auth/refresh', {
      refreshToken: f.initial.refreshToken,
    })
    assert.equal(refreshed.status, 200)
    assert.equal(refreshed.headers.get('cache-control'), 'no-store')
    const tokens = await refreshed.json()
    assert.deepEqual(Object.keys(tokens).sort(), [
      'accessToken',
      'accessTokenExpiresAt',
      'refreshToken',
      'sessionExpiresAt',
      'tokenType',
    ])
    assert.notEqual(tokens.refreshToken, f.initial.refreshToken)
    const principal = await f.verifyJwt(tokens.accessToken, Math.floor(Date.now() / 1000))
    assert.equal(principal.sessionId, f.initial.session.id)

    // 소비된 R0도 해당 session을 찾고, 성공 응답은 body 없는 204다.
    const firstLogout = await post(base, '/auth/logout', {
      refreshToken: f.initial.refreshToken,
    })
    assert.equal(firstLogout.status, 204)
    assert.equal(firstLogout.headers.get('cache-control'), 'no-store')
    assert.equal(await firstLogout.text(), '')

    for (const refreshToken of [f.initial.refreshToken, tokens.refreshToken, opaque()]) {
      const repeated = await post(base, '/auth/logout', { refreshToken })
      assert.equal(repeated.status, 204)
      assert.equal(await repeated.text(), '')
    }
    await expectAuthenticationRequired(
      await post(base, '/auth/refresh', { refreshToken: tokens.refreshToken }),
    )

    const sessionAfter = await stored(source, f.initial.session.id)
    assert.equal(sessionAfter.session.revoked_reason, 'logout')
    assert.equal(
      sessionAfter.session.last_active_at.getTime(),
      sessionBefore.session.last_active_at.getTime(),
    )
    assert.equal(sessionAfter.tokens.length, sessionBefore.tokens.length + 1)
    assert.equal(sessionAfter.tokens.some((row) => row.token_hash.equals(digest(tokens.refreshToken))), true)
    assert.deepEqual(await stored(source, otherDevice.initial.session.id), otherBefore)
  })
}

async function currentTokenLogout(source) {
  const f = await fixture(source)
  const before = await stored(source, f.initial.session.id)
  await withSessionApp(f, async (base) => {
    const response = await post(base, '/auth/logout', {
      refreshToken: f.initial.refreshToken,
    })
    assert.equal(response.status, 204)
    const after = await stored(source, f.initial.session.id)
    assert.equal(after.session.revoked_reason, 'logout')
    assert.equal(after.session.last_active_at.getTime(), before.session.last_active_at.getTime())
    assert.deepEqual(after.tokens, before.tokens)
  })
}

async function deletedSessionLogout(source) {
  const f = await fixture(source)
  const otherDevice = await fixture(source, f.identity)
  const otherBefore = await stored(source, otherDevice.initial.session.id)
  await source.query('DELETE FROM auth_sessions WHERE id=$1', [f.initial.session.id])

  await withSessionApp(f, async (base) => {
    const response = await post(base, '/auth/logout', {
      refreshToken: f.initial.refreshToken,
    })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(await response.text(), '')
  })

  assert.deepEqual(await stored(source, f.initial.session.id), {
    session: undefined,
    tokens: [],
  })
  assert.deepEqual(await stored(source, otherDevice.initial.session.id), otherBefore)
}

async function noResponseBeforeCommit(source, route) {
  const f = await fixture(source)
  const commitStarted = Promise.withResolvers()
  const releaseCommit = Promise.withResolvers()
  let held = false
  const restore = instrument(source, {
    commit: async (_runner, commit) => {
      if (!held) {
        held = true
        commitStarted.resolve()
        await releaseCommit.promise
      }
      await commit()
    },
  })
  try {
    await withSessionApp(f, async (base) => {
      try {
        let delivered = false
        const pending = settled(
          post(base, route, { refreshToken: f.initial.refreshToken }).then((response) => {
            delivered = true
            return response
          }),
        )
        await bounded(commitStarted.promise)
        assert.equal(delivered, false)
        releaseCommit.resolve()
        const result = await pending
        assert.equal(result.error, undefined)
        const isLogoutRoute = route.endsWith('logout')
        const expectedStatus = isLogoutRoute ? 204 : 200
        assert.equal(result.value.status, expectedStatus)
      } finally {
        releaseCommit.resolve()
      }
    })
  } finally {
    releaseCommit.resolve()
    restore()
  }
}

async function refreshThenLogoutWithLateResponse(source) {
  const f = await fixture(source)
  const refreshCommitted = Promise.withResolvers()
  const releaseRefreshResponse = Promise.withResolvers()
  let firstCommit = true
  const restore = instrument(source, {
    commit: async (_runner, commit) => {
      await commit()
      if (firstCommit) {
        firstCommit = false
        refreshCommitted.resolve()
        await releaseRefreshResponse.promise
      }
    },
  })
  try {
    await withSessionApp(f, async (base) => {
      try {
        let refreshDelivered = false
        const pendingRefresh = settled(
          post(base, '/auth/refresh', { refreshToken: f.initial.refreshToken }).then(
            async (response) => {
              refreshDelivered = true
              return { response, body: await response.json() }
            },
          ),
        )
        await bounded(refreshCommitted.promise)
        assert.equal(refreshDelivered, false)

        const logout = await post(base, '/auth/logout', {
          refreshToken: f.initial.refreshToken,
        })
        assert.equal(logout.status, 204)
        releaseRefreshResponse.resolve()

        const refreshResult = await pendingRefresh
        assert.equal(refreshResult.error, undefined)
        assert.equal(refreshResult.value.response.status, 200)
        await expectAuthenticationRequired(
          await post(base, '/auth/refresh', {
            refreshToken: refreshResult.value.body.refreshToken,
          }),
        )
        assert.equal((await stored(source, f.initial.session.id)).session.revoked_reason, 'logout')
      } finally {
        releaseRefreshResponse.resolve()
      }
    })
  } finally {
    releaseRefreshResponse.resolve()
    restore()
  }
}

async function logoutThenRefresh(source) {
  const f = await fixture(source)
  const logoutCommitted = Promise.withResolvers()
  const releaseLogoutResponse = Promise.withResolvers()
  let firstCommit = true
  const restore = instrument(source, {
    commit: async (_runner, commit) => {
      await commit()
      if (firstCommit) {
        firstCommit = false
        logoutCommitted.resolve()
        await releaseLogoutResponse.promise
      }
    },
  })
  try {
    await withSessionApp(f, async (base) => {
      try {
        let logoutDelivered = false
        const pendingLogout = settled(
          post(base, '/auth/logout', { refreshToken: f.initial.refreshToken }).then((response) => {
            logoutDelivered = true
            return response
          }),
        )
        await bounded(logoutCommitted.promise)
        assert.equal(logoutDelivered, false)
        await expectAuthenticationRequired(
          await post(base, '/auth/refresh', { refreshToken: f.initial.refreshToken }),
        )
        releaseLogoutResponse.resolve()
        const logoutResult = await pendingLogout
        assert.equal(logoutResult.error, undefined)
        assert.equal(logoutResult.value.status, 204)
      } finally {
        releaseLogoutResponse.resolve()
      }
    })
  } finally {
    releaseLogoutResponse.resolve()
    restore()
  }
}

async function uncertainCommit(source, route, applied) {
  const f = await fixture(source)
  const before = await stored(source, f.initial.session.id)
  const restore = instrument(source, {
    commit: async (runner, commit) => {
      if (applied) await commit()
      else await runner.rollbackTransaction()
      throw new Error('private credential SQL commit acknowledgement')
    },
  })
  try {
    await withSessionApp(f, async (base) => {
      const response = await post(base, route, { refreshToken: f.initial.refreshToken })
      assert.equal(response.status, 503)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const text = await response.text()
      assert.deepEqual(JSON.parse(text), unavailableBody)
      assert.doesNotMatch(text, /tokenType|accessToken|refreshToken|private|credential|SQL/)
    })
  } finally {
    restore()
  }
  const after = await stored(source, f.initial.session.id)
  if (!applied) {
    assert.deepEqual(after, before)
  } else {
    const isLogoutRoute = route.endsWith('logout')
    if (isLogoutRoute) {
      assert.equal(after.session.revoked_reason, 'logout')
      assert.deepEqual(after.tokens, before.tokens)
    } else {
      assert.equal(after.session.revoked_at, null)
      assert.equal(after.tokens.length, before.tokens.length + 1)
    }
  }
}

async function transportAndLogCanary(source) {
  const f = await fixture(source)
  const before = await stored(source, f.initial.session.id)
  const canary = `credential-canary-${opaque()}`
  let stdout = ''
  let stderr = ''
  const stdoutWrite = process.stdout.write
  const stderrWrite = process.stderr.write
  process.stdout.write = function (chunk, ...args) {
    const isBufferChunk = Buffer.isBuffer(chunk)
    stdout += isBufferChunk ? chunk.toString('utf8') : String(chunk)
    return stdoutWrite.call(this, chunk, ...args)
  }
  process.stderr.write = function (chunk, ...args) {
    const isBufferChunk = Buffer.isBuffer(chunk)
    stderr += isBufferChunk ? chunk.toString('utf8') : String(chunk)
    return stderrWrite.call(this, chunk, ...args)
  }
  try {
    await withSessionApp(f, async (base) => {
      for (const [path, chunks, headers, status, code] of [
        ['/auth/refresh', [Buffer.alloc(17_000)], { 'content-type': 'text/plain' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
        ['/auth/logout', [Buffer.alloc(8_000), Buffer.alloc(8_385)], {}, 413, 'REQUEST_TOO_LARGE'],
        ['/auth/refresh', [Buffer.from([0xff])], {}, 400, 'INVALID_AUTH_REQUEST'],
        ['/auth/logout', ['{'], {}, 400, 'INVALID_AUTH_REQUEST'],
        [
          '/auth/logout',
          [JSON.stringify({ refreshToken: f.initial.refreshToken, sessionId: canary })],
          {},
          400,
          'INVALID_AUTH_REQUEST',
        ],
        [
          '/auth/refresh',
          [JSON.stringify({ refreshToken: `${canary}=invalid` })],
          {},
          400,
          'INVALID_AUTH_REQUEST',
        ],
        [
          '/auth/logout',
          [JSON.stringify({ refreshToken: `${canary}=invalid` })],
          {},
          400,
          'INVALID_AUTH_REQUEST',
        ],
      ]) {
        const response = await postChunks(base, path, chunks, headers)
        assert.equal(response.status, status)
        assert.equal(JSON.parse(response.body).error.code, code)
        assert.doesNotMatch(response.body, /credential-canary|refreshToken|sessionId/)
      }
    })
  } finally {
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
  }
  assert.deepEqual(await stored(source, f.initial.session.id), before)
  assert.equal(stdout.includes(canary), false)
  assert.equal(stderr.includes(canary), false)
  assert.equal(stdout.includes(f.initial.refreshToken), false)
  assert.equal(stderr.includes(f.initial.refreshToken), false)
}

export async function assertSessionHttpIntegration(source, mark) {
  const cases = [
    ['normal refresh, consumed/repeated logout and other-device preservation', () => normalRefreshAndLogout(source)],
    ['current token logout preserves activity and refresh history', () => currentTokenLogout(source)],
    ['physically deleted session logout is 204 and preserves another device', () => deletedSessionLogout(source)],
    ['refresh response waits for commit', () => noResponseBeforeCommit(source, '/auth/refresh')],
    ['logout response waits for commit', () => noResponseBeforeCommit(source, '/auth/logout')],
    ['refresh commit then logout with delayed 200 leaves final token invalid', () => refreshThenLogoutWithLateResponse(source)],
    ['logout commit before refresh prevents issuance', () => logoutThenRefresh(source)],
    ...['/auth/refresh', '/auth/logout'].flatMap((route) =>
      [false, true].map((applied) => [
        `${route} uncertain ${applied ? 'committed' : 'rolled back'} outcome`,
        () => uncertainCommit(source, route, applied),
      ]),
    ),
    ['transport and shape rejection write nothing and omit credential canaries', () => transportAndLogCanary(source)],
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  return cases.length
}
