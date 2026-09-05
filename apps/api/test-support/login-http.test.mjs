/* global fetch */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { request } from 'node:http'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { creation, opaque } from './login-fixtures.mjs'

const { createLoginHttpApp } = await import('../dist/auth/login/http.js')
const { LoginFailure } = await import('../dist/errors/login.js')
const { LOGIN_ERRORS } = await import('../dist/constants/login.js')
let app
let base
let calls = 0
let failure
const run = (result) => { calls++; if (failure) throw failure; return result }
before(async () => {
  app = await createLoginHttpApp({
    create: () => run({ requestId: randomUUID(), browserUrl: 'https://api.test.invalid/auth/login/authorize?ticket=test', expiresAt: '2026-09-06T00:00:00.000Z' }),
    exchange: () => run({ tokenType: 'Bearer', accessToken: 'response-access', refreshToken: 'response-refresh' }),
    authorize: () => run({ redirectUrl: 'https://google.test.invalid/authorize?state=test', cookie: '__Host-test=x; Secure; HttpOnly; SameSite=Lax; Path=/' }),
    callback: () => run({ returnUrl: 'ldb-test://login/complete?code=exchange-only', cookie: '__Host-test=; Max-Age=0; Secure; HttpOnly; SameSite=Lax; Path=/' }),
  })
  await app.listen(0, '127.0.0.1')
  base = await app.getUrl()
})
after(async () => { await app.close() })

function post(path, chunks, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const body = []
      res.on('data', (part) => body.push(part))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(body).toString('utf8') }))
    })
    req.on('error', reject)
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

test('actual chunked stream cap and parser error priority run before auth service', async () => {
  const baseline = calls
  for (const path of ['/auth/login-requests', '/auth/exchange']) {
    for (const [chunks, headers, status, code] of [
      [[Buffer.alloc(17000)], { 'content-type': 'text/plain' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [[Buffer.alloc(17000)], { 'content-encoding': 'gzip' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [[Buffer.alloc(8000), Buffer.alloc(8385)], {}, 413, 'REQUEST_TOO_LARGE'],
      [[Buffer.alloc(16384, 'x')], {}, 400, 'INVALID_AUTH_REQUEST'],
      [[Buffer.from([0xff])], {}, 400, 'INVALID_AUTH_REQUEST'],
      [[], {}, 400, 'INVALID_AUTH_REQUEST'],
      [['{'], {}, 400, 'INVALID_AUTH_REQUEST'],
      [['null'], {}, 400, 'INVALID_AUTH_REQUEST'],
      [['[]'], {}, 400, 'INVALID_AUTH_REQUEST'],
    ]) {
      const response = await post(path, chunks, headers)
      assert.equal(response.status, status)
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.deepEqual(Object.keys(JSON.parse(response.body)), ['error'])
      assert.equal(JSON.parse(response.body).error.code, code)
      if (status === 413) assert.equal(response.headers.connection, 'close')
    }
  }
  assert.equal(calls, baseline)
})

test('HTTP rejects client-provided identity/redirect fields before service and accepts UTF-8 media', async () => {
  const baseline = calls
  const body = creation(opaque())
  for (const extra of [{ subject: 'do-not-trust' }, { returnUrl: 'https://evil.invalid' }, { clientId: 'web' }]) {
    assert.equal((await post('/auth/login-requests', [JSON.stringify({ ...body, ...extra })])).status, 400)
  }
  assert.equal(calls, baseline)
  const response = await post('/auth/login-requests', [JSON.stringify(body)], { 'content-type': 'application/json; charset=UTF-8', 'content-encoding': 'identity' })
  assert.equal(response.status, 201)
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('browser HTML, redirects and errors never echo untrusted data and prohibit active content', async () => {
  const response = await fetch(`${base}/auth/callback/google?state=${opaque()}&code=provider-sensitive&extra=%3Cscript%3E`, { redirect: 'manual' })
  const html = await response.text()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.match(html, /ldb-test:\/\/login\/complete\?code=exchange-only/)
  assert.doesNotMatch(html, /provider-sensitive|<script|<iframe|response-access|response-refresh/)
  failure = new Error('raw-provider-code identity SQL credential URL https://evil.invalid')
  try {
    const error = await fetch(`${base}/auth/callback/google?state=${opaque()}&code=private`, { redirect: 'manual' })
    assert.equal(error.status, 500)
    assert.doesNotMatch(await error.text(), /raw-provider|identity|SQL|credential|evil.invalid|private/)
    failure = new LoginFailure(LOGIN_ERRORS.EXCHANGE_INVALID)
    const json = await post('/auth/exchange', [JSON.stringify({ requestId: randomUUID(), clientId: 'desktop', code: opaque(), codeVerifier: opaque() })])
    assert.equal(json.status, 400)
    assert.deepEqual(JSON.parse(json.body), { error: { code: 'LOGIN_EXCHANGE_INVALID', message: '로그인 요청이 유효하지 않습니다. 다시 로그인해 주세요.' } })
  } finally { failure = undefined }
})
