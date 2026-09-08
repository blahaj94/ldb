/* global fetch */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { request } from 'node:http'
import { createLoginHttpApp, createSessionHttpService } from '../dist/auth/login/http.js'
import { fixture, stored } from './refresh-fixtures.mjs'
import { databaseNow } from './login-test-control.mjs'

const unusedLogin = Object.fromEntries(
  ['create', 'authorize', 'callback', 'exchange'].map((name) => [
    name,
    async () => {
      throw new Error('unrelated login route called')
    }
  ])
)

export async function accountFixture(source) {
  const f = await fixture(source)
  const now = await databaseNow(source)
  const issuedAt = now.getTime() / 1000
  await source.query('UPDATE auth_sessions SET created_at=$2,last_active_at=$2 WHERE id=$1', [
    f.initial.session.id,
    new Date(now.getTime() - 10_000)
  ])
  const token = await f.deps.issueAccessJwt({
    userId: f.initial.user.id,
    sessionId: f.initial.session.id,
    issuedAt,
    idleDeadline: issuedAt + 900
  })
  return { ...f, token, now }
}

export async function withAccountApp(f, operation, source = f.deps.dataSource) {
  const app = await createLoginHttpApp(unusedLogin, createSessionHttpService(f.deps), {
    dataSource: source,
    verifyAccessJwt: f.verifyJwt
  })
  await app.listen(0, '127.0.0.1')
  try {
    return await operation(await app.getUrl())
  } finally {
    await app.close()
  }
}

export function accountRequest(base, f, method = 'GET', body = { nickname: '변경 이름' }) {
  const isPatch = method === 'PATCH'
  return fetch(`${base}/me${isPatch ? '/nickname' : ''}`, {
    method,
    headers: { authorization: `Bearer ${f.token.accessToken}`, 'content-type': 'application/json' },
    ...(isPatch ? { body: JSON.stringify(body) } : {})
  })
}

export function rawAccountRequest(
  base,
  { method = 'PATCH', path = '/me/nickname', headers = {}, chunks = [] }
) {
  return new Promise((resolve, reject) => {
    const pending = request(`${base}${path}`, { method, headers }, (response) => {
      const parts = []
      response.on('data', (part) => parts.push(part))
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(parts).toString('utf8')
        })
      )
    })
    pending.on('error', reject)
    for (const chunk of chunks) {
      pending.write(chunk)
    }
    pending.end()
  })
}

export async function expectAccountError(response, status, code) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type'), /^application\/json/)
  const body = await response.json()
  assert.deepEqual(Object.keys(body), ['error'])
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message'])
  assert.equal(body.error.code, code)
  return body
}

export async function snapshot(source, f) {
  return {
    user: (await source.query('SELECT * FROM users WHERE id=$1', [f.initial.user.id]))[0],
    ...(await stored(source, f.initial.session.id))
  }
}
