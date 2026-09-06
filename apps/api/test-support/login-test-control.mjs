import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { clearTimeout, setTimeout } from 'node:timers'

export const settled = (operation) =>
  operation.then(
    (value) => ({ value }),
    (error) => ({ error }),
  )

export async function bounded(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('login test barrier timed out')), 5000)
      }),
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
    runner.query = (sql, parameters, ...rest) =>
      hooks.query
        ? hooks.query({
            runner,
            sql,
            parameters,
            query,
            run: () => query(sql, parameters, ...rest),
          })
        : query(sql, parameters, ...rest)
    runner.commitTransaction = () => (hooks.commit ? hooks.commit(runner, commit) : commit())
    return runner
  }
  return () => {
    source.createQueryRunner = create
  }
}

export async function blockedBy(source, waiter, blocker) {
  const deadline = Date.now() + 5000
  const expected = Array.isArray(blocker) ? blocker : [blocker]
  while (Date.now() < deadline) {
    const [state] = await source.query('SELECT pg_blocking_pids($1::int) AS blockers', [waiter])
    if (expected.some((pid) => state.blockers.includes(pid))) return
    await delay(10)
  }
  assert.fail('expected actual PostgreSQL lock contention')
}

export async function locked(source, table, id, operation) {
  assert(['auth_login_requests', 'users'].includes(table))
  const runner = source.createQueryRunner()
  try {
    await runner.connect()
    await runner.startTransaction('READ COMMITTED')
    const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid')
    await runner.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id])
    await operation({ runner, pid, unlock: () => runner.commitTransaction() })
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction()
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
  while (Date.now() < deadline) {
    if ((await databaseNow(source)) >= time) return
    await delay(20)
  }
  assert.fail('database clock did not reach test deadline')
}

export async function atExactTime(source, time, operation) {
  let clocks = 0
  const restore = instrument(source, {
    query: async ({ sql, run }) => {
      const result = await run()
      if (sql === 'SELECT to_timestamp(floor(extract(epoch from clock_timestamp()))) AS now') {
        clocks++
        return [{ now: time }]
      }
      return result
    },
  })
  try {
    await operation()
    assert(clocks > 0)
  } finally {
    restore()
  }
}
