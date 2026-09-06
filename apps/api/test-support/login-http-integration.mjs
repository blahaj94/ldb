/* global fetch */
import assert from 'node:assert/strict'
import { URL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createLoginHttpApp } from '../dist/auth/login/http.js'
import { creation, opaque } from './login-fixtures.mjs'
import { assertCleared, counts, digest, fixture, proof, row } from './login-database.mjs'
import { bounded, instrument, settled } from './login-test-control.mjs'

export async function assertLoginHttpIntegration(source, mark) {
  const f = await fixture(source)
  const app = await createLoginHttpApp(f.service)
  await app.listen(0, '127.0.0.1')
  try {
    const base = await app.getUrl()
    const post = (path, body) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const prepare = async () => {
      const verifier = opaque()
      const initialCounts = await counts(source)
      const created = await post('/auth/login-requests', creation(proof(verifier)))
      assert.equal(created.status, 201)
      assert.equal(created.headers.get('cache-control'), 'no-store')
      const request = await created.json()
      const launchUrl = new URL(request.browserUrl)
      const launch = await fetch(`${base}${launchUrl.pathname}${launchUrl.search}`, {
        redirect: 'manual',
      })
      assert.equal(launch.status, 303)
      assert.equal(launch.headers.get('cache-control'), 'no-store')
      assert.equal(launch.headers.get('referrer-policy'), 'no-referrer')
      const providerUrl = new URL(launch.headers.get('location'))
      const cookie = launch.headers.getSetCookie()[0].split(';')[0]
      const callback = await fetch(
        `${base}/auth/callback/google?state=${providerUrl.searchParams.get('state')}&code=fixture-provider-code`,
        {
          headers: { cookie },
          redirect: 'manual',
        },
      )
      assert.equal(callback.status, 200)
      assert.equal(callback.headers.get('cache-control'), 'no-store')
      assert.equal(callback.headers.get('referrer-policy'), 'no-referrer')
      const html = await callback.text()
      const code = /ldb-test:\/\/login\/complete\?code=([A-Za-z0-9_-]{43})/.exec(html)?.[1]
      assert(code)
      assert.doesNotMatch(
        html,
        /fixture-provider-code|accessToken|refreshToken|providerVerifier|<script/,
      )
      assert.deepEqual(await counts(source), initialCounts)
      return {
        request,
        exchange: {
          requestId: request.requestId,
          clientId: 'desktop',
          code,
          codeVerifier: verifier,
        },
      }
    }

    mark('HTTP through real database and JWT; response waits for commit confirmation')
    const flow = await prepare()
    const before = await counts(source)
    const denied = await post('/auth/exchange', { ...flow.exchange, codeVerifier: opaque() })
    assert.equal(denied.status, 400)
    assert.deepEqual(await counts(source), before)
    const committed = Promise.withResolvers(),
      release = Promise.withResolvers()
    const restore = instrument(source, {
      commit: async (_runner, commit) => {
        await commit()
        committed.resolve()
        await release.promise
      },
    })
    let delivered = false
    const pending = settled(
      post('/auth/exchange', flow.exchange).then((response) => {
        delivered = true
        return response
      }),
    )
    try {
      await bounded(committed.promise)
      await delay(0)
      assert.equal(delivered, false)
      assertCleared(await row(source, flow.request.requestId), 'consumed')
    } finally {
      release.resolve()
      restore()
    }
    const response = (await pending).value
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const tokens = await response.json()
    assert.deepEqual(Object.keys(tokens).sort(), [
      'accessToken',
      'accessTokenExpiresAt',
      'isNewUser',
      'refreshToken',
      'sessionExpiresAt',
      'tokenType',
      'user',
    ])
    assert.deepEqual(Object.keys(tokens.user).sort(), ['id', 'nickname'])
    const principal = await f.verifyJwt(tokens.accessToken, Math.floor(Date.now() / 1000))
    assert.equal(principal.userId, tokens.user.id)
    const [refresh] = await source.query(
      'SELECT token_hash FROM auth_refresh_tokens WHERE session_id=$1',
      [principal.sessionId],
    )
    assert.deepEqual(refresh.token_hash, digest(tokens.refreshToken))
    assert.equal((await post('/auth/exchange', flow.exchange)).status, 400)

    mark('HTTP commit uncertainty has only sanitized 503 and no token redelivery')
    const uncertain = await prepare()
    const undoHook = instrument(source, {
      commit: async (_runner, commit) => {
        await commit()
        throw new Error('fixture-secret SQL detail')
      },
    })
    let unavailable
    try {
      unavailable = await post('/auth/exchange', uncertain.exchange)
    } finally {
      undoHook()
    }
    assert.equal(unavailable.status, 503)
    assert.equal(unavailable.headers.get('cache-control'), 'no-store')
    const body = await unavailable.json()
    assert.deepEqual(Object.keys(body), ['error'])
    assert.equal(body.error.code, 'AUTH_UNAVAILABLE')
    assertCleared(await row(source, uncertain.request.requestId), 'consumed')
    const replay = await post('/auth/exchange', uncertain.exchange)
    assert.equal(replay.status, 400)
    assert.equal((await replay.json()).error.code, 'LOGIN_EXCHANGE_INVALID')
    return 2
  } finally {
    await app.close()
  }
}
