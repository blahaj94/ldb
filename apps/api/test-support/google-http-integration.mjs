/* global fetch */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { URL, URLSearchParams } from 'node:url'
import { createGoogleProviderVerifier } from '../dist/auth/google/index.js'
import { createLoginHttpApp } from '../dist/auth/login/http.js'
import { creation, opaque, registration } from './login-fixtures.mjs'
import { assertCleared, counts, digest, fixture, proof, row } from './login-database.mjs'
import { bounded } from './login-test-control.mjs'
import { jwksUri, signingKey, tokenEndpoint, tokenResponse } from './google-fixtures.mjs'

async function isolatedGoogle() {
  const key = await signingKey()
  const wrongKey = await signingKey(key.kid)
  const subject = randomUUID()
  const plans = new Map()
  const canaries = ['fixture-client-secret', 'fixture-raw-error', subject]
  const keyEntered = Promise.withResolvers()
  const releaseKey = Promise.withResolvers()
  let holdKeys = false
  let calls = 0
  let failed = false
  let aborted = 0
  const server = createServer(async (request, response) => {
    response.on('close', () => { if (!response.writableFinished) aborted += 1 })
    try {
      if (request.url === '/certs') {
        if (holdKeys) {
          keyEntered.resolve()
          await releaseKey.promise
        }
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({ keys: [key.jwk] }))
        return
      }
      assert.equal(request.url, '/token')
      assert.equal(request.method, 'POST')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      const plan = plans.get(form.get('code'))
      assert(plan)
      calls += 1
      assert(form.get('client_secret') === 'fixture-client-secret')
      assert.equal(form.get('client_id'), registration().providerClientId)
      assert.equal(form.get('redirect_uri'), registration().callbackUrl)
      assert.equal(form.get('grant_type'), 'authorization_code')
      assert(proof(form.get('code_verifier')) === plan.challenge)
      plan.entered.resolve()
      await plan.release.promise
      if (plan.mode === 'raw-error') {
        response.writeHead(400)
        response.end('fixture-raw-error fixture-client-secret')
        return
      }
      const tokens = await tokenResponse(plan.mode === 'signature' ? wrongKey : key, plan.nonce, {
        sub: subject,
        ...(plan.mode === 'nonce' ? { nonce: opaque() } : {}),
      })
      canaries.push(...Object.values(tokens))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(tokens))
    } catch {
      failed = true
      response.writeHead(500)
      response.end('isolated provider failure')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const verifyProvider = createGoogleProviderVerifier({
    registrations: [{ snapshot: registration(), tokenEndpoint, jwksUri }],
    resolveSecret: () => 'fixture-client-secret',
    fetch: (url, options) => {
      assert(url === tokenEndpoint || url === jwksUri)
      // Test transport만 trusted HTTPS URL을 disposable loopback HTTP server에 대응시킨다.
      return fetch(`${origin}${url === tokenEndpoint ? '/token' : '/certs'}`, options)
    },
  })
  return {
    verifyProvider, plans, canaries, subject, keyEntered, releaseKey,
    get calls() { return calls },
    get failed() { return failed },
    get aborted() { return aborted },
    holdKeys: () => { holdKeys = true },
    close: async () => {
      releaseKey.resolve()
      for (const plan of plans.values()) plan.release.resolve()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function httpRuntime(source, verifyProvider, overrides = {}) {
  const f = await fixture(source, { verifyProvider, ...overrides })
  const app = await createLoginHttpApp(f.service)
  await app.listen(0, '127.0.0.1')
  const base = await app.getUrl()
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { ...f, app, base, post }
}

async function prepare(runtime, google, mode = 'success', blocked = false) {
  const verifier = opaque()
  const created = await runtime.post('/auth/login-requests', creation(proof(verifier)))
  assert.equal(created.status, 201)
  const request = await created.json()
  const browser = new URL(request.browserUrl)
  const launch = await fetch(`${runtime.base}${browser.pathname}${browser.search}`, { redirect: 'manual' })
  assert.equal(launch.status, 303)
  const authorization = new URL(launch.headers.get('location'))
  assert.equal(authorization.searchParams.get('scope'), 'openid profile')
  assert.equal(authorization.searchParams.get('access_type'), null)
  const code = opaque()
  const plan = {
    mode,
    nonce: authorization.searchParams.get('nonce'),
    challenge: authorization.searchParams.get('code_challenge'),
    entered: Promise.withResolvers(), release: Promise.withResolvers(),
  }
  if (!blocked) plan.release.resolve()
  google.plans.set(code, plan)
  google.canaries.push(code, verifier, plan.nonce)
  const cookie = launch.headers.getSetCookie()[0].split(';')[0]
  const callback = () => fetch(`${runtime.base}/auth/callback/google?state=${authorization.searchParams.get('state')}&code=${code}`, {
    headers: { cookie }, redirect: 'manual',
  })
  return { request, verifier, plan, callback }
}

async function completion(flow, response, canaries) {
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const html = await response.text()
  assert(canaries.every((value) => !html.includes(value)))
  const code = /ldb-test:\/\/login\/complete\?code=([A-Za-z0-9_-]{43})/.exec(html)?.[1]
  assert(code)
  return { requestId: flow.request.requestId, clientId: 'desktop', code, codeVerifier: flow.verifier }
}

export async function assertGoogleHttpIntegration(source, mark) {
  const google = await isolatedGoogle()
  let runtime
  let rollbackRuntime
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  const captured = []
  const capture = (chunk, encoding, callback) => {
    captured.push(String(chunk))
    if (typeof encoding === 'function') encoding()
    else if (typeof callback === 'function') callback()
    return true
  }
  process.stdout.write = capture
  process.stderr.write = capture
  try {
    runtime = await httpRuntime(source, google.verifyProvider)
    const existingSessions = await source.query('SELECT * FROM auth_sessions ORDER BY id')
    const existingRefresh = await source.query('SELECT * FROM auth_refresh_tokens ORDER BY token_hash')
    const baseline = await counts(source)

    mark('actual RS256 callback duplicate does not repeat exchange or hold row lock')
    const flow = await prepare(runtime, google, 'success', true)
    const beforeCalls = google.calls
    const pendingCallback = flow.callback()
    await bounded(flow.plan.entered.promise)
    assert.equal((await row(source, flow.request.requestId)).status, 'processing')
    await source.transaction(async (manager) => {
      await manager.query('SELECT id FROM auth_login_requests WHERE id=$1 FOR UPDATE NOWAIT', [flow.request.requestId])
    })
    assert.equal((await flow.callback()).status, 400)
    assert.equal(google.calls, beforeCalls + 1)
    flow.plan.release.resolve()
    const exchange = await completion(flow, await pendingCallback, google.canaries)
    assert.deepEqual(await counts(source), baseline)

    mark('actual adapter exchange is single-use with real ES256 JWT and independent session')
    const denied = await runtime.post('/auth/exchange', { ...exchange, codeVerifier: opaque() })
    assert.equal(denied.status, 400)
    assert.deepEqual(await counts(source), baseline)
    const responses = await Promise.all([runtime.post('/auth/exchange', exchange), runtime.post('/auth/exchange', exchange)])
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400])
    const tokens = await responses.find((response) => response.status === 200).json()
    assert.equal(tokens.isNewUser, true)
    assert.deepEqual(Object.keys(tokens.user).sort(), ['id', 'nickname'])
    assert(google.canaries.every((value) => !JSON.stringify(tokens).includes(value)))
    const principal = await runtime.verifyJwt(tokens.accessToken, Math.floor(Date.now() / 1000))
    assert.equal(principal.userId, tokens.user.id)
    const [storedUser] = await source.query('SELECT provider, provider_subject FROM users WHERE id=$1', [tokens.user.id])
    assert.equal(storedUser.provider, 'google')
    assert(storedUser.provider_subject === google.subject)
    const [refresh] = await source.query('SELECT token_hash FROM auth_refresh_tokens WHERE session_id=$1', [principal.sessionId])
    assert(refresh.token_hash.equals(digest(tokens.refreshToken)))
    assertCleared(await row(source, flow.request.requestId), 'consumed')
    assert.deepEqual(await counts(source), { users: baseline.users + 1, sessions: baseline.sessions + 1, refresh: baseline.refresh + 1 })

    const preservedSession = await source.query('SELECT * FROM auth_sessions WHERE id=$1', [principal.sessionId])
    const preservedRefresh = await source.query('SELECT * FROM auth_refresh_tokens WHERE session_id=$1', [principal.sessionId])
    const second = await prepare(runtime, google)
    const secondExchange = await completion(second, await second.callback(), google.canaries)
    const secondTokens = await (await runtime.post('/auth/exchange', secondExchange)).json()
    assert.equal(secondTokens.isNewUser, false)
    assert.equal(secondTokens.user.id, tokens.user.id)
    assert.equal(secondTokens.user.nickname, tokens.user.nickname)
    const secondPrincipal = await runtime.verifyJwt(secondTokens.accessToken, Math.floor(Date.now() / 1000))
    assert.notEqual(secondPrincipal.sessionId, principal.sessionId)
    assert.deepEqual(await source.query('SELECT * FROM auth_sessions WHERE id=$1', [principal.sessionId]), preservedSession)
    assert.deepEqual(await source.query('SELECT * FROM auth_refresh_tokens WHERE session_id=$1', [principal.sessionId]), preservedRefresh)

    mark('signature/nonce/upstream failures have no member/session/token effects or raw errors')
    for (const mode of ['signature', 'nonce', 'raw-error']) {
      const before = await counts(source)
      const rejected = await prepare(runtime, google, mode)
      const callback = await rejected.callback()
      assert.equal(callback.status, 502)
      const html = await callback.text()
      assert(html.includes('소셜 로그인을 완료하지 못했습니다. 다시 시도해 주세요.'))
      assert(google.canaries.every((value) => !html.includes(value)))
      assert(!html.includes('ldb-test:'))
      assertCleared(await row(source, rejected.request.requestId), 'failed')
      const exchangeResponse = await runtime.post('/auth/exchange', {
        requestId: rejected.request.requestId, clientId: 'desktop', code: opaque(), codeVerifier: rejected.verifier,
      })
      assert.equal(exchangeResponse.status, 400)
      assert.deepEqual(await counts(source), before)
    }

    mark('JWT failure rolls back actual-adapter exchange and preserves all existing sessions')
    rollbackRuntime = await httpRuntime(source, google.verifyProvider, {
      issueAccessJwt: async () => { throw new Error('fixture-raw-error') },
    })
    const beforeRollback = await counts(source)
    const rollback = await prepare(rollbackRuntime, google)
    const rollbackExchange = await completion(rollback, await rollback.callback(), google.canaries)
    const rollbackResponse = await rollbackRuntime.post('/auth/exchange', rollbackExchange)
    assert.equal(rollbackResponse.status, 500)
    assert.deepEqual(await counts(source), beforeRollback)
    assert.equal((await row(source, rollback.request.requestId)).status, 'exchange_ready')

    mark('one real 10-second callback deadline spans token wait plus JWKS HTTP; late response stays failed')
    const beforeTimeout = await counts(source)
    const timeout = await prepare(runtime, google, 'success', true)
    google.holdKeys()
    const startedAt = Date.now()
    const timeoutResponse = timeout.callback()
    await bounded(timeout.plan.entered.promise)
    await delay(6000)
    timeout.plan.release.resolve()
    await bounded(google.keyEntered.promise)
    const timedOut = await timeoutResponse
    assert.equal(timedOut.status, 502)
    assert(Date.now() - startedAt < 13_000, 'JWKS must not restart the callback deadline')
    assertCleared(await row(source, timeout.request.requestId), 'failed')
    google.releaseKey.resolve()
    await delay(20)
    assert(google.aborted > 0)
    assertCleared(await row(source, timeout.request.requestId), 'failed')
    assert.deepEqual(await counts(source), beforeTimeout)
    assert.equal((await timeout.callback()).status, 400)

    assert.deepEqual(await source.query('SELECT * FROM auth_sessions WHERE id=ANY($1) ORDER BY id', [existingSessions.map((session) => session.id)]), existingSessions)
    assert.deepEqual(await source.query('SELECT * FROM auth_refresh_tokens WHERE session_id=ANY($1) ORDER BY token_hash', [existingSessions.map((session) => session.id)]), existingRefresh)
    const databaseText = JSON.stringify(await source.query('SELECT row_to_json(r) AS request FROM auth_login_requests r'))
    // 검증된 subject는 미소비 exchange_ready row의 승인된 field이며 token 원문과 구분한다.
    assert(google.canaries.filter((value) => value !== google.subject).every((value) => !databaseText.includes(value)))
    assert.equal(google.failed, false)
    return 8
  } finally {
    try {
      await rollbackRuntime?.app.close()
      await runtime?.app.close()
      await google.close()
    } finally {
      process.stdout.write = stdout
      process.stderr.write = stderr
      assert.equal(captured.length, 0, 'actual Google adapter HTTP/DB success, failure and timeout produce no logs')
    }
  }
}
