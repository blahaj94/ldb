import assert from 'node:assert/strict'
import { blockedBy, bounded, databaseNow, settled, waitUntil } from './login-test-control.mjs'
import { fixture, stored, setDeadline, withLock } from './refresh-fixtures.mjs'
import {
  searchFixture,
  withSearchApp,
  searchRequest,
  observeSearchRunners
} from './character-search-fixtures.mjs'
import { cleanupWaitingOn, targets, withCleanupDeletionHeld } from './cleanup-database-control.mjs'

async function activityFirst(source, cleanup) {
  const f = await searchFixture(source)
  const committing = Promise.withResolvers()
  const release = Promise.withResolvers()
  let activityAt
  const createQueryRunner = observeSearchRunners({
    commit: async (runner, commit) => {
      activityAt = (
        await runner.query('SELECT last_active_at FROM auth_sessions WHERE id=$1', [
          f.initial.session.id
        ])
      )[0].last_active_at
      committing.resolve((await runner.query('SELECT pg_backend_pid() AS pid'))[0].pid)
      await release.promise
      await commit()
    }
  })
  await withSearchApp(
    f,
    async ({ base, calls }) => {
      const deadline = new Date((await databaseNow(source)).getTime() + 1000)
      await setDeadline(source, f.initial.session.id, deadline)
      const pending = settled(searchRequest(base, f))
      try {
        const pid = await bounded(committing.promise)
        assert(activityAt < deadline)
        // 후보 조회 시에는 아직 commit되지 않은 활동을 볼 수 없어 만료된 옛 row가 선택된다.
        await waitUntil(source, deadline)
        await cleanupWaitingOn({
          source,
          cleanup,
          table: 'auth_sessions',
          id: f.initial.session.id,
          blocker: pid,
          unlock: () => release.resolve()
        })
        const result = await pending
        assert.equal(result.error, undefined)
        assert.equal(result.value.status, 200)
        assert.equal(calls.length, 1)
      } finally {
        release.resolve()
        await pending
      }
    },
    { createQueryRunner }
  )
  const final = await stored(source, f.initial.session.id)
  assert.equal(final.session.last_active_at.getTime(), activityAt.getTime())
  assert.equal(final.tokens.length, 1)
}

async function cleanupFirst(source, cleanup) {
  const f = await searchFixture(source)
  await setDeadline(source, f.initial.session.id, await databaseNow(source))
  const userBefore = await source.query('SELECT * FROM users WHERE id=$1', [f.initial.user.id])
  const activityLock = Promise.withResolvers()
  const createQueryRunner = observeSearchRunners({
    query: async ({ sql, parameters, query, run }) => {
      const isLock =
        targets({
          sql,
          parameters,
          verb: 'SELECT',
          table: 'auth_sessions',
          id: f.initial.session.id
        }) && sql.includes('FOR UPDATE')
      if (isLock) {
        activityLock.resolve((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
      }
      return run()
    }
  })
  let signingCalls = 0
  const signer = f.deps.issueAccessJwt
  f.deps.issueAccessJwt = async (input) => {
    signingCalls++
    return signer(input)
  }
  await withSearchApp(
    f,
    async ({ base, calls }) => {
      await withCleanupDeletionHeld({
        source,
        cleanup,
        table: 'auth_sessions',
        id: f.initial.session.id,
        operation: async ({ pid, waiter, release }) => {
          const activity = settled(searchRequest(base, f))
          const refresh = settled(f.rotate(f.initial.refreshToken))
          try {
            const activityPid = await bounded(activityLock.promise)
            const refreshPid = await bounded(waiter)
            await blockedBy(source, activityPid, [pid, refreshPid])
            await blockedBy(source, refreshPid, [pid, activityPid])
            release()
            assert.equal((await refresh).error?.code, 'AUTHENTICATION_REQUIRED')
            const result = await activity
            assert.equal(result.error, undefined)
            assert.equal(result.value.status, 200)
            assert.equal(calls.length, 1)
          } finally {
            release()
            await Promise.all([activity, refresh])
          }
        }
      })
    },
    { createQueryRunner }
  )
  assert.equal(signingCalls, 0)
  assert.deepEqual(await stored(source, f.initial.session.id), { session: undefined, tokens: [] })
  assert.deepEqual(
    await source.query('SELECT * FROM users WHERE id=$1', [f.initial.user.id]),
    userBefore
  )
}

async function staleSessionHint(source, cleanup, change) {
  const f = await fixture(source)
  const other = await fixture(source)
  const otherBefore = await stored(source, other.initial.session.id)
  await setDeadline(source, f.initial.session.id, await databaseNow(source))
  await withLock(source, 'auth_sessions', f, async ({ runner, pid }) => {
    await cleanupWaitingOn({
      source,
      cleanup,
      table: 'auth_sessions',
      id: f.initial.session.id,
      blocker: pid,
      unlock: async () => {
        const canCommit = runner.isTransactionActive
        if (!canCommit) {
          return
        }
        const shouldDelete = change === 'deleted'
        if (shouldDelete) {
          await runner.query('DELETE FROM auth_sessions WHERE id=$1', [f.initial.session.id])
        } else {
          await runner.query('UPDATE auth_sessions SET user_id=$2 WHERE id=$1', [
            f.initial.session.id,
            other.initial.user.id
          ])
        }
        await runner.commitTransaction()
      }
    })
  })
  const final = await stored(source, f.initial.session.id)
  const wasDeleted = change === 'deleted'
  if (wasDeleted) {
    assert.deepEqual(final, { session: undefined, tokens: [] })
  } else {
    assert.equal(final.session.user_id, other.initial.user.id)
    assert.equal(final.tokens.length, 1)
  }
  assert.deepEqual(await stored(source, other.initial.session.id), otherBefore)
  await cleanup(source)
}

export async function assertCleanupSessionConcurrency(source, cleanup, mark) {
  const cases = [
    ['actual search activity commits before waiting cleanup', () => activityFirst(source, cleanup)],
    [
      'cleanup holds deletion while refresh and residual search wait',
      () => cleanupFirst(source, cleanup)
    ],
    ['session disappears after cleanup hint', () => staleSessionHint(source, cleanup, 'deleted')],
    [
      'session ownership changes after cleanup hint',
      () => staleSessionHint(source, cleanup, 'ownership')
    ]
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  return cases.length
}
