import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { searchFixture, withSearchApp, searchRequest, expectSearchError, snapshot, observeSearchRunners, barrier, assertBackendGone } from './character-search-fixtures.mjs'
import { withLock } from './refresh-fixtures.mjs'
import { bounded, blockedBy } from './login-test-control.mjs'

async function lockedDatabaseDeadline(source, mark) {
  const f = await searchFixture(source)
  const before = await snapshot(source, f)
  const entered = barrier()
  let releases = 0
  let cancellations = 0
  const createQueryRunner = observeSearchRunners({
    created: (_runner, signal) => signal.addEventListener('abort', () => { cancellations += 1 }, { once: true }),
    released: () => { releases += 1 },
    query: async ({ sql, query, run }) => {
      const isSessionLock = sql.includes('auth_sessions') && sql.includes('FOR UPDATE')
      if (isSessionLock) {
        const [{ pid }] = await query('SELECT pg_backend_pid() AS pid')
        entered.resolve(pid)
      }
      return run()
    },
  })
  await withLock(source, 'auth_sessions', f, async ({ pid: blocker, unlock }) => {
    await withSearchApp(f, async ({ base, calls }) => {
      const started = performance.now()
      const pending = searchRequest(base, f)
      const pid = await bounded(entered.promise)
      await blockedBy(source, pid, blocker)
      mark('two-second locked search returns sanitized HTTP 500')
      const response = await pending
      await expectSearchError(response, 500, 'INTERNAL_SERVER_ERROR')
      const duration = performance.now() - started
      assert(duration >= 1800 && duration < 3500)
      // Client close만으로 server-side lock 대기가 취소됐다고 추정하지 않고 backend 소멸을 확인한다.
      mark('locked search backend disappears while external blocker stays locked')
      await assertBackendGone(source, pid)
      assert.equal(cancellations, 1)
      assert.equal(releases, 1)
      assert.equal(calls.length, 0)
      assert.deepEqual(await snapshot(source, f), before)
      await unlock()
      await delay(20)
      assert.equal(calls.length, 0)
    }, { createQueryRunner })
  })
}

async function lateCommitAcknowledgement(source) {
  const f = await searchFixture(source)
  const before = await snapshot(source, f)
  const committed = barrier()
  const acknowledge = barrier()
  let releases = 0
  const createQueryRunner = observeSearchRunners({
    commit: async (_runner, commit) => {
      await commit()
      committed.resolve()
      await acknowledge.promise
    },
    released: () => { releases += 1 },
  })
  await withSearchApp(f, async ({ base, calls }) => {
    const pending = searchRequest(base, f)
    try {
      await bounded(committed.promise)
      assert((await snapshot(source, f)).session.last_active_at > before.session.last_active_at)
      await expectSearchError(await pending, 500, 'INTERNAL_SERVER_ERROR')
      assert.equal(calls.length, 0)
    } finally {
      acknowledge.resolve()
    }
    await delay(20)
    assert.equal(releases, 1)
    assert.equal(calls.length, 0)
  }, { createQueryRunner })
}

export async function assertSearchCancellation(source, mark) {
  const cases = [
    ['actual PostgreSQL lock waiter and connection disappear after one two-second deadline', () => lockedDatabaseDeadline(source, mark)],
    ['late committed acknowledgement stays 500 with activity retained and upstream zero', () => lateCommitAcknowledgement(source)],
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  return cases.length
}
