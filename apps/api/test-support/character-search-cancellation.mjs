import assert from 'node:assert/strict'
import { DataSource } from 'typeorm'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import {
  searchFixture,
  withSearchApp,
  searchRequest,
  expectSearchError,
  snapshot,
  observeSearchRunners,
  barrier,
  assertBackendGone
} from './character-search-fixtures.mjs'
import { withLock } from './refresh-fixtures.mjs'
import { bounded, blockedBy, settled } from './login-test-control.mjs'

async function lockedDatabaseDeadline(source, mark) {
  const f = await searchFixture(source)
  const before = await snapshot(source, f)
  const entered = barrier()
  let releases = 0
  let cancellations = 0
  const createQueryRunner = observeSearchRunners({
    created: (_runner, signal) =>
      signal.addEventListener(
        'abort',
        () => {
          cancellations += 1
        },
        { once: true }
      ),
    released: () => {
      releases += 1
    },
    query: async ({ sql, query, run }) => {
      const isSessionLock = sql.includes('auth_sessions') && sql.includes('FOR UPDATE')
      if (isSessionLock) {
        const [{ pid }] = await query('SELECT pg_backend_pid() AS pid')
        entered.resolve(pid)
      }
      return run()
    }
  })
  await withLock(source, 'auth_sessions', f, async ({ pid: blocker, unlock }) => {
    await withSearchApp(
      f,
      async ({ base, calls }) => {
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
      },
      { createQueryRunner }
    )
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
    released: () => {
      releases += 1
    }
  })
  await withSearchApp(
    f,
    async ({ base, calls }) => {
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
    },
    { createQueryRunner }
  )
}

async function disconnectedRequest(source, queued) {
  const f = await searchFixture(source)
  const before = await snapshot(source, f)
  const locking = barrier()
  let connections = 0
  let verifications = 0
  const verifiedAgain = barrier()
  const createQueryRunner = observeSearchRunners({
    created: () => {
      connections += 1
    },
    query: async ({ sql, query, run }) => {
      const isSessionLock = sql.includes('auth_sessions') && sql.includes('FOR UPDATE')
      if (isSessionLock) {
        locking.resolve((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
      }
      return run()
    }
  })
  const verifyAccessJwt = async (...args) => {
    const principal = await f.verifyJwt(...args)
    verifications += 1
    const isSecond = verifications === 2
    if (isSecond) {
      verifiedAgain.resolve()
    }
    return principal
  }
  await withLock(source, 'auth_sessions', f, async ({ pid: blocker, unlock }) => {
    await withSearchApp(
      f,
      async ({ base, calls }) => {
        const controller = new AbortController()
        const first = settled(
          searchRequest(base, f, undefined, queued ? {} : { signal: controller.signal })
        )
        const pid = await bounded(locking.promise)
        await blockedBy(source, pid, blocker)
        let aborted = first
        if (queued) {
          aborted = settled(searchRequest(base, f, undefined, { signal: controller.signal }))
          await bounded(verifiedAgain.promise)
          await delay(10)
        }
        controller.abort()
        assert.equal((await aborted).error.name, 'AbortError')
        if (!queued) {
          await assertBackendGone(source, pid)
        }
        assert.equal(calls.length, 0)
        assert.equal(connections, 1)
        assert.deepEqual(await snapshot(source, f), before)
        await unlock()
        if (queued) {
          assert.equal((await first).value.status, 200)
          await delay(20)
          assert.equal(calls.length, 1)
          assert.equal(connections, 1)
        }
        const priorCalls = queued ? 1 : 0
        for (let count = priorCalls; count < 10; count += 1) {
          assert.equal((await searchRequest(base, f)).status, 200)
        }
        await expectSearchError(await searchRequest(base, f), 429, 'SEARCH_RATE_LIMITED')
        assert.equal(calls.length, 10)
      },
      { createQueryRunner, verifyAccessJwt }
    )
  })
}

async function shutdownDuringLock(source) {
  const f = await searchFixture(source)
  const before = await snapshot(source, f)
  const locking = barrier()
  let releases = 0
  const createQueryRunner = observeSearchRunners({
    released: () => {
      releases += 1
    },
    query: async ({ sql, query, run }) => {
      const isSessionLock = sql.includes('auth_sessions') && sql.includes('FOR UPDATE')
      if (isSessionLock) {
        locking.resolve((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
      }
      return run()
    }
  })
  await withLock(source, 'auth_sessions', f, async ({ pid: blocker }) => {
    await withSearchApp(
      f,
      async ({ base, calls, app }) => {
        const pending = searchRequest(base, f)
        const pid = await bounded(locking.promise)
        await blockedBy(source, pid, blocker)
        await bounded(app.close())
        await expectSearchError(await pending, 500, 'INTERNAL_SERVER_ERROR')
        await assertBackendGone(source, pid)
        assert.equal(calls.length, 0)
        assert.equal(releases, 1)
        assert.deepEqual(await snapshot(source, f), before)
      },
      { createQueryRunner }
    )
  })
}

async function exhaustedPool(source) {
  const f = await searchFixture(source)
  const isolated = new DataSource({ ...source.options, poolSize: 1 })
  await isolated.initialize()
  const held = isolated.createQueryRunner()
  try {
    await held.connect()
    await withSearchApp(
      f,
      async ({ base, calls }) => {
        assert.equal((await searchRequest(base, f)).status, 200)
        assert.equal(calls.length, 1)
      },
      { dataSource: isolated }
    )
  } finally {
    await held.release()
    await isolated.destroy()
  }
}

export async function assertSearchCancellation(source, mark) {
  const cases = [
    [
      'actual PostgreSQL lock waiter and connection disappear after one two-second deadline',
      () => lockedDatabaseDeadline(source, mark)
    ],
    [
      'late committed acknowledgement stays 500 with activity retained and upstream zero',
      () => lateCommitAcknowledgement(source)
    ],
    [
      'active HTTP disconnect aborts actual DB waiter without reservation',
      () => disconnectedRequest(source, false)
    ],
    [
      'queued HTTP disconnect removes admission reference without opening a DB connection',
      () => disconnectedRequest(source, true)
    ],
    [
      'application shutdown aborts and releases an actual DB lock waiter',
      () => shutdownDuringLock(source)
    ],
    [
      'exhausted TypeORM pool does not create an uncancellable search acquisition waiter',
      () => exhaustedPool(source)
    ]
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  return cases.length
}
