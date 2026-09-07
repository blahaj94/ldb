import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settled } from './login-test-control.mjs'

function fixture() {
  const events = []
  let now = 0
  let nextTimer = 0
  const timers = new Map()
  const clock = {
    now: () => now,
    setTimer(callback, delay) {
      const id = ++nextTimer
      timers.set(id, { callback, at: now + delay })
      return id
    },
    clearTimer: (timer) => timers.delete(timer),
  }
  const checkedAtSeconds = 1000
  const principal = { userId: 'account', sessionId: 'session', issuedAt: 900, expiresAt: 1100 }
  const state = {
    session: { id: 'session', userId: 'account', lastActiveAt: new Date(990_000), revokedAt: null },
    checkedAt: new Date(checkedAtSeconds * 1000), lock: undefined, commit: undefined,
    calls: 0, writes: 0, commits: 0, connections: 0, releases: 0, cancellations: 0,
  }
  const deps = {
    apiKey: 'synthetic-search-key', dataSource: {}, clock,
    verifyAccessJwt: async () => principal,
    createQueryRunner(_source, signal) {
      state.connections += 1
      let released = false
      const cancelled = () => { state.cancellations += 1 }
      signal.addEventListener('abort', cancelled, { once: true })
      const runner = {
        isTransactionActive: false,
        async connect() { events.push('connect') },
        async startTransaction() { runner.isTransactionActive = true },
        manager: {
          getRepository(schema) {
            assert.equal(schema.options.tableName, 'auth_sessions')
            return {
              async findOne(options) {
                assert.deepEqual(options.where, { id: principal.sessionId, userId: principal.userId })
                assert.deepEqual(options.lock, { mode: 'pessimistic_write' })
                events.push('lock')
                const hasBarrier = state.lock != null
                if (hasBarrier) await state.lock()
                return state.session
              },
              async update(_where, values) {
                state.writes += 1
                state.session.lastActiveAt = values.lastActiveAt
                events.push('write')
              },
            }
          },
          async query(sql) {
            assert.match(sql, /clock_timestamp\(\)/)
            events.push('clock')
            return [{ now: state.checkedAt }]
          },
        },
        async commitTransaction() {
          const hasBarrier = state.commit != null
          if (hasBarrier) await state.commit()
          state.commits += 1
          runner.isTransactionActive = false
          events.push('commit')
        },
        async rollbackTransaction() { runner.isTransactionActive = false },
        async release() {
          if (released) return
          released = true
          signal.removeEventListener('abort', cancelled)
          state.releases += 1
          events.push('release')
        },
      }
      return runner
    },
    async searchCharacters() {
      state.calls += 1
      events.push('upstream')
      return { rows: [] }
    },
  }
  return {
    deps, state, principal, events,
    advance(time) {
      now = time
      for (const [id, timer] of timers) {
        const isDue = timer.at <= now
        if (!isDue) continue
        timers.delete(id)
        timer.callback()
      }
    },
  }
}

const headers = ['Authorization', 'Bearer synthetic-access-value']
const originalUrl = '/characters?characterName=ab'

async function service(f) {
  const { createAuthenticatedSearchService } = await import('../dist/characters/authenticated-search.js')
  return createAuthenticatedSearchService(f.deps)
}

test('search service locks only session, reads fresh time, commits before reserving and starting upstream', async () => {
  const f = fixture()
  const search = await service(f)
  try {
    assert.deepEqual(await search.search(headers, originalUrl), { rows: [] })
    assert.deepEqual(f.events, ['connect', 'lock', 'clock', 'write', 'commit', 'release', 'upstream'])
    assert.equal(f.state.session.lastActiveAt.getTime(), 1_000_000)
  } finally {
    search.onModuleDestroy()
  }
})

test('search post-lock JWT equality and active idle equality refuse with no write or call', async () => {
  for (const kind of ['jwt', 'idle']) {
    const f = fixture()
    const isJwtBoundary = kind === 'jwt'
    if (isJwtBoundary) f.principal.expiresAt = 1000
    else f.state.session.lastActiveAt = new Date((1000 - 2_592_000) * 1000)
    const search = await service(f)
    try {
      await assert.rejects(search.search(headers, originalUrl), { status: 401 })
      assert.equal(f.state.writes, 0)
      assert.equal(f.state.calls, 0)
    } finally {
      search.onModuleDestroy()
    }
  }
})

test('search missing or revoked session allows residual request with activity zero', async () => {
  for (const kind of ['missing', 'revoked']) {
    const f = fixture()
    const isMissing = kind === 'missing'
    if (isMissing) f.state.session = null
    else {
      f.state.session.revokedAt = new Date(999_000)
      f.state.session.lastActiveAt = new Date((1000 - 2_592_000) * 1000)
    }
    const search = await service(f)
    try {
      assert.deepEqual(await search.search(headers, originalUrl), { rows: [] })
      assert.equal(f.state.writes, 0)
      assert.equal(f.state.calls, 1)
    } finally {
      search.onModuleDestroy()
    }
  }
})

test('search timeout cancels DB ownership, and a late lock result cannot write, commit or call upstream', async () => {
  const f = fixture()
  let unlock
  let locked
  const atLock = new Promise((resolve) => { locked = resolve })
  f.state.lock = () => {
    locked()
    return new Promise((resolve) => { unlock = resolve })
  }
  const search = await service(f)
  try {
    const pending = settled(search.search(headers, originalUrl))
    await atLock
    f.advance(2000)
    assert.equal((await pending).error.status, 500)
    assert.equal(f.state.cancellations, 1)
    unlock()
    // Late callback의 continuation까지 실행한다. 실제 연결 종료는 별도 native test에서 검증한다.
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    assert.equal(f.state.writes, 0)
    assert.equal(f.state.commits, 0)
    assert.equal(f.state.calls, 0)
    assert.equal(f.state.releases, 1)
  } finally {
    search.onModuleDestroy()
  }
})

test('search commit acknowledgement failure keeps upstream and reservation zero without claiming rollback', async () => {
  const f = fixture()
  f.state.commit = async () => { throw new Error('private commit detail') }
  const search = await service(f)
  try {
    for (let count = 0; count < 11; count += 1) {
      await assert.rejects(search.search(headers, originalUrl), { status: 500 })
    }
    assert.equal(f.state.calls, 0)
    assert.equal(f.state.connections, 11)
    f.state.commit = undefined
    assert.deepEqual(await search.search(headers, originalUrl), { rows: [] })
  } finally {
    search.onModuleDestroy()
  }
})
