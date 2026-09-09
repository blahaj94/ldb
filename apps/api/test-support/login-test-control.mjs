import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { clearTimeout, setTimeout } from 'node:timers'

export const settled = (operation) =>
  operation.then(
    (value) => ({ value }),
    (error) => ({ error })
  )

export async function bounded(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('login test barrier timed out')), 5000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Test가 실제 QueryRunner 경계를 관측/고장 주입한다. 제품의 test mode는 추가하지 않는다.
export function instrument(source, hooks) {
  const create = source.createQueryRunner
  source.createQueryRunner = function (...args) {
    const runner = create.apply(this, args)
    const query = runner.query.bind(runner)
    const commit = runner.commitTransaction.bind(runner)
    runner.query = (sql, parameters, ...rest) => {
      const shouldUseQueryHook = Boolean(hooks.query)
      return shouldUseQueryHook
        ? hooks.query({
            runner,
            sql,
            parameters,
            query,
            run: () => query(sql, parameters, ...rest)
          })
        : query(sql, parameters, ...rest)
    }
    runner.commitTransaction = () => {
      const shouldUseCommitHook = Boolean(hooks.commit)
      return shouldUseCommitHook ? hooks.commit(runner, commit) : commit()
    }
    return runner
  }
  return () => {
    source.createQueryRunner = create
  }
}

export async function blockedBy(source, waiter, blocker) {
  const deadline = Date.now() + 5000
  const isBlockerArray = Array.isArray(blocker)
  const expected = isBlockerArray ? blocker : [blocker]
  while (true) {
    const canObserveBlockers = Date.now() < deadline
    if (!canObserveBlockers) {
      break
    }
    const [state] = await source.query('SELECT pg_blocking_pids($1::int) AS blockers', [waiter])
    const hasExpectedBlocker = expected.some((pid) => state.blockers.includes(pid))
    if (hasExpectedBlocker) {
      return
    }
    await delay(10)
  }
  assert.fail('expected actual PostgreSQL lock contention')
}

export async function locked(source, table, id, operation) {
  const isSupportedLockTable = ['auth_login_requests', 'users'].includes(table)
  assert(isSupportedLockTable)
  const runner = source.createQueryRunner()
  try {
    await runner.connect()
    await runner.startTransaction('READ COMMITTED')
    const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid')
    await runner.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id])
    await operation({ runner, pid, unlock: () => runner.commitTransaction() })
  } finally {
    if (runner.isTransactionActive) {
      await runner.rollbackTransaction()
    }
    await runner.release()
  }
}

export async function databaseNow(source) {
  return (
    await source.query('SELECT to_timestamp(floor(extract(epoch from clock_timestamp()))) AS now')
  )[0].now
}

export async function waitUntil(source, time) {
  const deadline = Date.now() + 5000
  while (true) {
    const canWaitForDatabaseTime = Date.now() < deadline
    if (!canWaitForDatabaseTime) {
      break
    }
    const hasReachedDatabaseTime = (await databaseNow(source)) >= time
    if (hasReachedDatabaseTime) {
      return
    }
    await delay(20)
  }
  assert.fail('database clock did not reach test deadline')
}

export async function atExactTime(source, time, operation) {
  let clocks = 0
  const restore = instrument(source, {
    query: async ({ sql, run }) => {
      const result = await run()
      const isClockQuery =
        sql === 'SELECT to_timestamp(floor(extract(epoch from clock_timestamp()))) AS now'
      if (isClockQuery) {
        clocks++
        return [{ now: time }]
      }
      return result
    }
  })
  try {
    await operation()
    const hasObservedClockQuery = clocks > 0
    assert(hasObservedClockQuery)
  } finally {
    restore()
  }
}
