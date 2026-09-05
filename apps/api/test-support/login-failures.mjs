import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { URL, URLSearchParams } from 'node:url'
import { registration, registryConfiguration, opaque } from './login-fixtures.mjs'
import { assertCleared, counts, failure, fixture, ready, row, started } from './login-database.mjs'
import { atExactTime, instrument } from './login-test-control.mjs'

async function assertExchangeRollback(source) {
  const f = await fixture(source)
  const flow = await ready(f.service)
  const before = await counts(source), original = await row(source, flow.request.requestId)
  let consumedWrites = 0
  const restore = instrument(source, { query: async ({ sql, parameters, run }) => {
    const result = await run()
    if (sql.startsWith('UPDATE "auth_login_requests"') && parameters.includes('consumed')) {
      consumedWrites++
      throw new Error('fixture-secret SQL detail')
    }
    return result
  } })
  try { await failure(() => f.service.exchange(flow.exchange), 'AUTH_UNAVAILABLE') } finally { restore() }
  assert.equal(consumedWrites, 1)
  assert.deepEqual(await counts(source), before)
  assert.deepEqual(await row(source, flow.request.requestId), original)
  assert.equal((await f.service.exchange(flow.exchange)).isNewUser, true)
}

async function assertUnknownExchangeCommit(source, committed) {
  const f = await fixture(source)
  const flow = await ready(f.service)
  const before = await counts(source)
  let commits = 0
  const restore = instrument(source, { commit: async (_runner, commit) => {
    commits++
    if (committed) await commit()
    throw new Error('fixture-secret lost commit result')
  } })
  try { await failure(() => f.service.exchange(flow.exchange), 'AUTH_UNAVAILABLE') } finally { restore() }
  assert.equal(commits, 1)
  const stored = await row(source, flow.request.requestId)
  if (committed) {
    assertCleared(stored, 'consumed')
    await failure(() => f.service.exchange(flow.exchange), 'LOGIN_EXCHANGE_INVALID')
    assert.deepEqual(await counts(source), { users: before.users + 1, sessions: before.sessions + 1, refresh: before.refresh + 1 })
  } else {
    assert.equal(stored.status, 'exchange_ready')
    assert.deepEqual(await counts(source), before)
  }
}

async function assertUnknownCallbackCommit(source, commitNumber) {
  const f = await fixture(source)
  const flow = await started(f.service)
  let commits = 0
  const restore = instrument(source, { commit: async (_runner, commit) => {
    await commit()
    if (++commits === commitNumber) throw new Error('fixture-secret lost callback commit result')
  } })
  const query = new URLSearchParams({ state: flow.state, code: 'fixture-provider-code' })
  try { await failure(() => f.service.callback('google', query, flow.cookie), 'AUTH_UNAVAILABLE') } finally { restore() }
  assert.equal(f.verifiedCalls.length, commitNumber - 1)
  assert.equal((await row(source, flow.request.requestId)).status, commitNumber === 1 ? 'processing' : 'exchange_ready')
  await failure(() => f.service.callback('google', query, flow.cookie), 'LOGIN_REQUEST_INVALID')
  assert.equal(f.verifiedCalls.length, commitNumber - 1)
  if (commitNumber === 1) {
    // Crash/commit 응답 유실 뒤 남은 processing도 만료 read에서 정리한다.
    const expiresAt = (await row(source, flow.request.requestId)).expires_at
    await atExactTime(source, expiresAt, () => failure(() => f.service.callback('google', query, flow.cookie), 'LOGIN_REQUEST_INVALID'))
    assertCleared(await row(source, flow.request.requestId), 'failed')
  }
}

async function assertSnapshotsAndKeys(source) {
  const { createLoginService } = await import('../dist/auth/login/service.js')
  const { LoginRegistry } = await import('../dist/auth/login/registry.js')
  const { ProviderPkceKeys } = await import('../dist/auth/login/crypto.js')
  const f = await fixture(source)
  const flow = await started(f.service)
  const config = registryConfiguration()
  const v2 = registration('google', 'test-v2')
  v2.providerClientId = 'test-client-v2'
  v2.expectedAudience = v2.providerClientId
  v2.returnTarget.url = 'ldb-test://login/v2'
  config.registrations.push(v2)
  config.activeVersions.google = 'test-v2'
  const service = createLoginService({ ...f.dependencies, registry: new LoginRegistry(config) })
  const completion = await service.callback('google', new URLSearchParams({ state: flow.state, code: 'fixture-provider-code' }), flow.cookie)
  assert.equal(f.verifiedCalls.at(-1).snapshot.version, 'test-v1')
  assert.equal(f.verifiedCalls.at(-1).snapshot.providerClientId, 'google-test-client')
  assert(completion.returnUrl.startsWith('ldb-test://login/complete?code='))
  await service.exchange({ requestId: flow.request.requestId, clientId: 'desktop', code: new URL(completion.returnUrl).searchParams.get('code'), codeVerifier: flow.verifier })

  const missing = await ready(f.service)
  const withoutHistory = createLoginService({ ...f.dependencies, registry: new LoginRegistry({ ...config, registrations: [v2], activeVersions: { google: 'test-v2' } }) })
  await failure(() => withoutHistory.exchange(missing.exchange), 'AUTH_INTERNAL_ERROR')
  assertCleared(await row(source, missing.request.requestId), 'failed')

  const cannotDecrypt = await started(f.service)
  const changedKeys = createLoginService({ ...f.dependencies, pkceKeys: new ProviderPkceKeys({ activeKeyId: 'new-key', keys: [{ id: 'new-key', key: randomBytes(32) }] }) })
  const before = f.verifiedCalls.length
  await failure(() => changedKeys.callback('google', new URLSearchParams({ state: cannotDecrypt.state, code: 'fixture-provider-code' }), cannotDecrypt.cookie), 'AUTH_INTERNAL_ERROR')
  assert.equal(f.verifiedCalls.length, before)
  assertCleared(await row(source, cannotDecrypt.request.requestId), 'failed')

  const valid = await ready(f.service)
  const original = await row(source, valid.request.requestId), count = await counts(source)
  await failure(() => f.service.exchange({ ...valid.exchange, clientId: 'another-client' }), 'LOGIN_EXCHANGE_INVALID')
  await failure(() => f.service.exchange({ ...valid.exchange, codeVerifier: opaque() }), 'LOGIN_EXCHANGE_INVALID')
  assert.deepEqual(await row(source, valid.request.requestId), original)
  assert.deepEqual(await counts(source), count)
}

export async function assertLoginFailures(source, mark) {
  const cases = [
    ['actual consumed UPDATE rollback', () => assertExchangeRollback(source)],
    ['exchange commit succeeded but result lost', () => assertUnknownExchangeCommit(source, true)],
    ['exchange commit failed before send', () => assertUnknownExchangeCommit(source, false)],
    ['callback claim commit result lost and expired processing cleanup', () => assertUnknownCallbackCommit(source, 1)],
    ['callback completion commit result lost', () => assertUnknownCallbackCommit(source, 2)],
    ['historical registration, missing snapshot/key and invalid client isolation', () => assertSnapshotsAndKeys(source)],
  ]
  for (const [name, run] of cases) { mark(name); await run() }
  return cases.length
}
