import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import process from 'node:process'
import { URL } from 'node:url'
import { command } from './docker-postgres.mjs'
import { insertLogin, loginRequest } from './database-contract.mjs'
import { databaseNow, instrument } from './login-test-control.mjs'
import { fixture, digest, stored, setDeadline, rejected } from './refresh-fixtures.mjs'
import { logoutSession } from '../dist/auth/logout/index.js'
import { assertCleanupSessionConcurrency } from './cleanup-session-concurrency.mjs'
import { assertCleanupOAuthConcurrency } from './cleanup-oauth-concurrency.mjs'

async function eligibleRows(source, cleanup) {
  const active = await fixture(source)
  const current = (await active.rotate(active.initial.refreshToken)).refreshToken
  const now = await databaseNow(source)
  const old = new Date(now.getTime() - 40 * 86_400_000)
  await source.query('UPDATE auth_sessions SET created_at=$2 WHERE id=$1', [active.initial.session.id, old])
  await source.query('UPDATE auth_refresh_tokens SET issued_at=$2, consumed_at=$2 WHERE token_hash=$1', [digest(active.initial.refreshToken), old])
  const preserved = await stored(source, active.initial.session.id)
  const revoked = await fixture(source)
  await revoked.rotate(revoked.initial.refreshToken)
  await logoutSession(source, revoked.initial.refreshToken)
  const expired = await fixture(source)
  await setDeadline(source, expired.initial.session.id, now)
  const requestCases = []
  for (const status of ['created', 'browser_started', 'processing', 'exchange_ready', 'consumed', 'failed']) {
    for (const expiredRequest of [false, true]) {
      const request = loginRequest(status, randomUUID(), {
        created_at: new Date(now.getTime() - (expiredRequest ? 600_000 : 60_000)),
        expires_at: expiredRequest ? now : new Date(now.getTime() + 540_000),
      })
      for (const field of ['launch_ticket_hash', 'state_hash', 'exchange_code_hash']) {
        const hasHash = request[field] != null
        if (hasHash) request[field] = randomBytes(32)
      }
      const hasCode = status === 'exchange_ready'
      const isConsumed = status === 'consumed'
      if (hasCode) request.code_expires_at = now
      if (isConsumed) request.consumed_at = now
      await insertLogin(source, request)
      const isTerminal = status === 'consumed' || status === 'failed'
      requestCases.push({ request, shouldDelete: expiredRequest || isTerminal })
    }
  }
  await cleanup(source)
  assert.deepEqual(await stored(source, active.initial.session.id), preserved)
  for (const f of [revoked, expired]) {
    assert.deepEqual(await stored(source, f.initial.session.id), { session: undefined, tokens: [] })
    await rejected(() => f.rotate(f.initial.refreshToken))
    await logoutSession(source, f.initial.refreshToken)
    assert.equal((await source.query('SELECT id FROM users WHERE id=$1', [f.initial.user.id])).length, 1)
  }
  for (const { request, shouldDelete } of requestCases) {
    const rows = await source.query('SELECT * FROM auth_login_requests WHERE id=$1', [request.id])
    if (shouldDelete) assert.deepEqual(rows, [])
    else assert.deepEqual(rows, [request])
  }
  assert.deepEqual(await cleanup(source), { sessionsDeleted: 0, loginRequestsDeleted: 0 })
  await active.rotate(current)
  // 보존한 old hash는 여전히 known consumed이므로 reuse 폐기 의미도 그대로다.
  await rejected(() => active.rotate(active.initial.refreshToken))
  assert.equal((await stored(source, active.initial.session.id)).session.revoked_reason, 'refresh_reuse')
  await cleanup(source)
}

async function transactionFailure(source, cleanup, outcome) {
  await cleanup(source)
  const fixtures = [await fixture(source), await fixture(source)]
  for (const f of fixtures) await logoutSession(source, f.initial.refreshToken)
  const ordered = fixtures.toSorted((left, right) => left.initial.session.id.localeCompare(right.initial.session.id))
  let commits = 0
  const restore = instrument(source, {
    commit: async (runner, commit) => {
      commits++
      const isFirstCommit = commits === 1
      if (isFirstCommit) return commit()
      const shouldCommit = outcome === 'committed'
      if (shouldCommit) await commit()
      else await runner.rollbackTransaction()
      throw new Error('fixture-private commit acknowledgement lost')
    },
  })
  try {
    await assert.rejects(cleanup(source), (error) => {
      assert.equal(error.message, 'Authentication cleanup failed')
      assert.equal(error.stack, 'Error: Authentication cleanup failed')
      assert.equal(error.cause, undefined)
      return true
    })
    assert.equal(commits, 2)
  } finally {
    restore()
  }
  assert.equal((await stored(source, ordered[0].initial.session.id)).session, undefined)
  const remaining = await stored(source, ordered[1].initial.session.id)
  const wasCommitted = outcome === 'committed'
  assert.equal(remaining.session == null, wasCommitted)
  await cleanup(source)
  for (const f of fixtures) assert.deepEqual(await stored(source, f.initial.session.id), { session: undefined, tokens: [] })
}

async function compiledCommand(source, configuration) {
  const f = await fixture(source)
  await logoutSession(source, f.initial.refreshToken)
  const before = (await source.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()'))[0].count
  const environment = {
    DB_HOST: configuration.host, DB_PORT: String(configuration.port),
    DB_USERNAME: configuration.username, DB_PASSWORD: configuration.password,
    DB_NAME: configuration.database,
  }
  const result = await command(process.execPath, ['--import', 'reflect-metadata', 'dist/auth/cleanup/cli.js'], {
    cwd: new URL('..', import.meta.url), env: environment,
  })
  assert.deepEqual({ code: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, {
    code: 0, signal: null, stdout: 'Authentication cleanup completed\n', stderr: '',
  })
  assert.deepEqual(await stored(source, f.initial.session.id), { session: undefined, tokens: [] })
  const after = (await source.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()'))[0].count
  assert.equal(after, before)
  const failed = await command(process.execPath, ['--import', 'reflect-metadata', 'dist/auth/cleanup/cli.js'], {
    cwd: new URL('..', import.meta.url), env: { ...environment, DB_NAME: 'fixture_missing_database' },
  })
  assert.equal(failed.code, 1)
  assert.equal(failed.signal, null)
  assert.equal(failed.stdout, '')
  assert.equal(failed.stderr, 'Authentication cleanup failed\n')
}

export async function assertAuthenticationCleanup(source, configuration, mark) {
  // 기존 harness가 disposable DB와 compiled Migration을 준비한 뒤에만 제품 entry를 load한다.
  const { cleanupAuthentication } = await import('../dist/auth/cleanup/index.js')
  const cases = [
    ['eligibility, retained history, exact request/session boundary and repetition', () => eligibleRows(source, cleanupAuthentication)],
    ['partial prior commit with final rollback', () => transactionFailure(source, cleanupAuthentication, 'rolled-back')],
    ['partial prior commit with unknown committed result', () => transactionFailure(source, cleanupAuthentication, 'committed')],
    ['compiled explicit command and owned connection teardown', () => compiledCommand(source, configuration)],
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  const sessions = await assertCleanupSessionConcurrency(source, cleanupAuthentication, mark)
  const oauth = await assertCleanupOAuthConcurrency(source, cleanupAuthentication, mark)
  return cases.length + sessions + oauth
}
