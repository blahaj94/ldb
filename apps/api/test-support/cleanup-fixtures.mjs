import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const checkedAt = new Date('2026-09-08T00:00:00Z')
export const idleMilliseconds = 2_592_000_000

// 후보는 일부러 활성 row도 반환한다. 삭제 권한은 잠금 뒤 재판정에서만 생긴다.
export function cleanupFixture({
  sessions = [],
  requests = [],
  beforeLock,
  beforeCommit,
  afterCommit
} = {}) {
  const events = []
  const deleted = { sessions: [], requests: [] }
  let commits = 0
  const source = {
    query: async (sql) => {
      const isSessionQuery = sql.includes('auth_sessions')
      const isRequestQuery = sql.includes('auth_login_requests')
      const isCleanupQuery = isSessionQuery || isRequestQuery
      assert(isCleanupQuery)
      const rows = isSessionQuery ? sessions : requests
      return rows.map((row) => ({ ...row, user_id: row.userId }))
    },
    transaction: async (isolation, operation) => {
      assert.equal(isolation, 'READ COMMITTED')
      const pending = []
      let locked = false
      const manager = {
        query: async (sql) => {
          assert.match(sql, /clock_timestamp\(\)/)
          assert.match(sql, /floor\(/)
          assert.equal(locked, true, 'clock must be read after row lock')
          events.push('fresh-time')
          return [{ now: checkedAt }]
        },
        getRepository: (schema) => {
          const isSession = schema.options.tableName === 'auth_sessions'
          const rows = isSession ? sessions : requests
          const kind = isSession ? 'sessions' : 'requests'
          return {
            findOne: async (options) => {
              assert.equal(options.lock.mode, 'pessimistic_write')
              events.push('lock')
              locked = true
              await beforeLock?.(rows, options.where.id)
              return rows.find((row) => row.id === options.where.id) ?? null
            },
            delete: async (where) => {
              const isDirectId = typeof where === 'string'
              const id = isDirectId ? where : where.id
              pending.push([kind, id])
              return { affected: 1 }
            }
          }
        }
      }
      const result = await operation(manager)
      commits++
      await beforeCommit?.(commits)
      for (const [kind, id] of pending) {
        deleted[kind].push(id)
      }
      events.push('commit')
      await afterCommit?.()
      return result
    }
  }
  return { source, deleted, events }
}

export function session(patch = {}) {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActiveAt: checkedAt,
    revokedAt: null,
    revokedReason: null,
    ...patch
  }
}

export function request(patch = {}) {
  return {
    id: randomUUID(),
    status: 'processing',
    expiresAt: new Date(checkedAt.getTime() + 60_000),
    codeExpiresAt: null,
    ...patch
  }
}
