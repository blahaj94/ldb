/* global fetch */
import assert from 'node:assert/strict'
import {
  searchFixture,
  withSearchApp,
  searchRequest,
  expectSearchError,
  snapshot,
  observeSearchRunners,
  barrier,
  waitFor,
  assertBackendGone
} from './character-search-fixtures.mjs'
import { setDeadline, withLock } from './refresh-fixtures.mjs'
import { bounded, blockedBy, databaseNow, waitUntil } from './login-test-control.mjs'

async function exactTime(source, kind, offset) {
  const f = await searchFixture(source)
  const isIdle = kind === 'idle'
  if (isIdle) {
    const issuedAt = f.now.getTime() / 1000 - 10
    f.token = await f.deps.issueAccessJwt({
      userId: f.initial.user.id,
      sessionId: f.initial.session.id,
      issuedAt,
      idleDeadline: issuedAt + 900
    })
    await setDeadline(source, f.initial.session.id, f.now)
  }
  const isIat = kind === 'iat'
  const tokenBoundary = isIat ? f.token.issuedAt : f.token.expiresAt
  const boundary = isIdle ? f.now.getTime() / 1000 : tokenBoundary
  const target = new Date((boundary + offset) * 1000)
  const before = await snapshot(source, f)
  let clocks = 0
  const createQueryRunner = observeSearchRunners({
    query: async ({ sql, run }) => {
      const result = await run()
      const isClock = sql.includes('clock_timestamp()')
      if (!isClock) {
        return result
      }
      clocks += 1
      return [{ now: target }]
    }
  })
  await withSearchApp(
    f,
    async ({ base, calls }) => {
      const response = await searchRequest(base, f)
      const isExpired = offset >= 0
      const isNotIssued = offset < 0
      const shouldRefuse = isIat ? isNotIssued : isExpired
      if (shouldRefuse) {
        await expectSearchError(response, 401, 'AUTHENTICATION_REQUIRED')
        assert.equal(calls.length, 0)
        assert.deepEqual(await snapshot(source, f), before)
      } else {
        assert.equal(response.status, 200)
        assert.equal(calls.length, 1)
      }
      assert.equal(clocks, 1)
    },
    { createQueryRunner }
  )
}

async function nearSecondBoundary(source) {
  // 실제 만료를 넘는 lock 대기와 2초 admission timeout을 구분할 여유를 확보한다.
  await waitFor(async () => {
    const [{ fraction }] = await source.query(
      'SELECT extract(epoch from clock_timestamp()) % 1 AS fraction'
    )
    const phase = Number(fraction)
    const hasMargin = phase >= 0.5 && phase <= 0.75
    return hasMargin
  })
  return new Date((await databaseNow(source)).getTime() + 2000)
}

async function realLockExpiry(source, kind) {
  const f = await searchFixture(source)
  const target = await nearSecondBoundary(source)
  const isJwt = kind === 'jwt'
  if (isJwt) {
    f.token = await f.deps.issueAccessJwt({
      userId: f.initial.user.id,
      sessionId: f.initial.session.id,
      issuedAt: f.now.getTime() / 1000,
      idleDeadline: target.getTime() / 1000
    })
  } else {
    await setDeadline(source, f.initial.session.id, target)
  }
  const before = await snapshot(source, f)
  const locking = barrier()
  const createQueryRunner = observeSearchRunners({
    query: async ({ sql, query, run }) => {
      const isSessionLock = sql.includes('auth_sessions') && sql.includes('FOR UPDATE')
      if (isSessionLock) {
        locking.resolve((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
      }
      return run()
    }
  })
  await withLock(source, 'auth_sessions', f, async ({ pid: blocker, unlock }) => {
    await withSearchApp(
      f,
      async ({ base, calls }) => {
        const pending = searchRequest(base, f)
        const pid = await bounded(locking.promise)
        await blockedBy(source, pid, blocker)
        await waitUntil(source, target)
        await unlock()
        await expectSearchError(await pending, 401, 'AUTHENTICATION_REQUIRED')
        assert.equal(calls.length, 0)
        assert.deepEqual(await snapshot(source, f), before)
        await assertBackendGone(source, pid)
      },
      { createQueryRunner }
    )
  })
}

async function residual(source, kind) {
  const f = await searchFixture(source)
  await withSearchApp(f, async ({ base, calls }) => {
    const isLogout = kind === 'logout'
    const isDeletedUser = kind === 'deleted-user'
    const isDeletedSession = kind === 'deleted-session'
    const isExpiredRevoked = kind === 'expired-revoked'
    if (isLogout || isExpiredRevoked) {
      const response = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: f.initial.refreshToken })
      })
      assert.equal(response.status, 204)
    }
    if (isExpiredRevoked) {
      await setDeadline(source, f.initial.session.id, f.now)
    }
    if (isDeletedUser) {
      await source.query('DELETE FROM users WHERE id=$1', [f.initial.user.id])
    }
    if (isDeletedSession) {
      await source.query('DELETE FROM auth_sessions WHERE id=$1', [f.initial.session.id])
    }
    const before = await snapshot(source, f)
    assert.equal((await searchRequest(base, f)).status, 200)
    assert.equal(calls.length, 1)
    assert.deepEqual(await snapshot(source, f), before)
  })
}

async function removalAfterActivity(source, kind) {
  const f = await searchFixture(source)
  const before = await snapshot(source, f)
  let base
  const createQueryRunner = observeSearchRunners({
    commit: async (_runner, commit) => {
      await commit()
      const isLogout = kind === 'logout'
      if (isLogout) {
        const response = await fetch(`${base}/auth/logout`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: f.initial.refreshToken })
        })
        assert.equal(response.status, 204)
      } else {
        await source.query('DELETE FROM users WHERE id=$1', [f.initial.user.id])
      }
    }
  })
  await withSearchApp(
    f,
    async (context) => {
      base = context.base
      assert.equal((await searchRequest(base, f)).status, 200)
      assert.equal(context.calls.length, 1)
      const after = await snapshot(source, f)
      const isLogout = kind === 'logout'
      if (isLogout) {
        assert(after.session.revoked_at != null)
        assert(after.session.last_active_at > before.session.last_active_at)
      } else {
        assert.equal(after.user, undefined)
        assert.equal(after.session, undefined)
        assert.deepEqual(after.tokens, [])
      }
    },
    { createQueryRunner }
  )
}

async function expiredAfterAdmission(source) {
  const f = await searchFixture(source)
  const target = await nearSecondBoundary(source)
  f.token = await f.deps.issueAccessJwt({
    userId: f.initial.user.id,
    sessionId: f.initial.session.id,
    issuedAt: f.now.getTime() / 1000,
    idleDeadline: target.getTime() / 1000
  })
  const before = await snapshot(source, f)
  let commits = 0
  const createQueryRunner = observeSearchRunners({
    commit: async (_runner, commit) => {
      await commit()
      commits += 1
      await waitUntil(source, target)
    }
  })
  await withSearchApp(
    f,
    async ({ base, calls }) => {
      assert.equal((await searchRequest(base, f)).status, 200)
      await expectSearchError(await searchRequest(base, f), 401, 'AUTHENTICATION_REQUIRED')
      assert.equal(commits, 1)
      assert.equal(calls.length, 1)
      assert((await snapshot(source, f)).session.last_active_at > before.session.last_active_at)
    },
    { createQueryRunner }
  )
}

export async function assertSearchSessionBoundaries(source, mark) {
  const cases = [
    ...['jwt', 'idle', 'iat'].flatMap((kind) =>
      [-1, 0].map((offset) => [
        `${kind} exact fresh DB boundary offset ${offset}`,
        () => exactTime(source, kind, offset)
      ])
    ),
    ...['jwt', 'idle'].map((kind) => [
      `real session lock crosses ${kind} boundary`,
      () => realLockExpiry(source, kind)
    ]),
    ...['logout', 'deleted-user', 'deleted-session', 'expired-revoked'].map((kind) => [
      `${kind} residual request preserves all remaining state`,
      () => residual(source, kind)
    ]),
    ...['logout', 'delete'].map((kind) => [
      `${kind} after activity commit preserves admitted search`,
      () => removalAfterActivity(source, kind)
    ]),
    [
      'JWT expiry after admitted commit does not revoke request but rejects new admission',
      () => expiredAfterAdmission(source)
    ]
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  return cases.length
}
