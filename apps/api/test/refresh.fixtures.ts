import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DataSource, EntityManager } from 'typeorm'
import type { IssueAccessJwt } from '../src/auth/access-jwt/types.js'
import { UserSchema } from '../src/database/schemas/users.js'
import { AuthSessionSchema } from '../src/database/schemas/auth-sessions.js'
import { AuthRefreshTokenSchema } from '../src/database/schemas/auth-refresh-tokens.js'

export const time = new Date('2026-09-06T00:00:10Z')
export const idleSeconds = 2_592_000
export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest()
interface Tokens {
  tokenType: 'Bearer'
  accessToken: string
  accessTokenExpiresAt: string
  refreshToken: string
  sessionExpiresAt: string
}
interface Dependencies { dataSource: DataSource; issueAccessJwt: IssueAccessJwt }
interface RefreshModule {
  rotateRefresh(deps: Dependencies, token: unknown): Promise<Tokens>
  rotateRefreshForTest(deps: Dependencies, token: unknown, entropy: (size: number) => Buffer): Promise<Tokens>
}
export const load = () => import(new URL('../src/auth/refresh/index.js', import.meta.url).href) as Promise<RefreshModule>

export function fixture() {
  const bytes = randomBytes(32)
  const raw = bytes.toString('base64url')
  const user = { id: randomUUID() }
  const session = {
    id: randomUUID(), userId: user.id, createdAt: time, lastActiveAt: time,
    revokedAt: null as Date | null, revokedReason: null as string | null,
  }
  const token = { tokenHash: digest(bytes), sessionId: session.id, issuedAt: time, consumedAt: null as Date | null }
  const events: string[] = []
  const inserted: Record<string, unknown>[] = []
  const state = {
    userMissing: false, sessionMissing: false, tokenMissing: false, hintMissing: false,
    freshTime: time, beforeCommit: async () => {}, beforeLockedRead: () => {},
    beforeInsert: () => {},
  }
  const users = {
    findOne: async (query: { where: unknown; lock: unknown }) => {
      events.push('user-lock')
      assert.deepEqual(query, { where: { id: user.id }, lock: { mode: 'pessimistic_write' } })
      state.beforeLockedRead()
      return state.userMissing ? null : { ...user }
    },
  }
  const sessions = {
    findOneBy: async (where: unknown) => {
      events.push('session-hint')
      assert.deepEqual(where, { id: token.sessionId })
      return { ...session }
    },
    findOne: async () => {
      events.push('session-lock')
      return state.sessionMissing ? null : { ...session }
    },
    update: async (where: unknown, values: Record<string, unknown>) => {
      events.push('revoke')
      assert.deepEqual(where, { id: session.id })
      assert.deepEqual(values, { revokedAt: state.freshTime, revokedReason: 'refresh_reuse' })
      Object.assign(session, values)
    },
  }
  const refresh = {
    findOneBy: async (where: unknown) => {
      events.push('refresh-hint')
      assert.deepEqual(where, { tokenHash: digest(bytes) })
      return state.hintMissing ? null : { ...token }
    },
    findOne: async (query: unknown) => {
      events.push('refresh-lock')
      assert.deepEqual(query, { where: { tokenHash: digest(bytes) }, lock: { mode: 'pessimistic_write' } })
      return state.tokenMissing ? null : { ...token }
    },
    update: async (where: unknown, values: { consumedAt: Date }) => {
      events.push('consume')
      assert.deepEqual(where, { tokenHash: digest(bytes) })
      Object.assign(token, values)
    },
    insert: async (value: Record<string, unknown>) => {
      events.push('insert')
      state.beforeInsert()
      inserted.push(value)
    },
  }
  const manager = {
    getRepository: (schema: unknown) => {
      if (schema === UserSchema) return users
      if (schema === AuthSessionSchema) return sessions
      assert.equal(schema, AuthRefreshTokenSchema)
      return refresh
    },
    query: async (sql: string) => {
      assert.equal(sql, 'SELECT to_timestamp(floor(extract(epoch from clock_timestamp()))) AS now')
      events.push('fresh-time')
      return [{ now: state.freshTime }]
    },
  } as unknown as EntityManager
  const deps: Dependencies = {
    dataSource: {
      transaction: async (isolation: string, run: (manager: EntityManager) => Promise<unknown>) => {
        assert.equal(isolation, 'READ COMMITTED')
        events.push('begin')
        const before = { token: { ...token }, session: { ...session } }
        try {
          const result = await run(manager)
          await state.beforeCommit()
          events.push('commit')
          return result
        } catch (error) {
          Object.assign(token, before.token)
          Object.assign(session, before.session)
          inserted.length = 0
          events.push('rollback')
          throw error
        }
      },
    } as unknown as DataSource,
    issueAccessJwt: async (input) => {
      events.push('sign')
      assert.deepEqual(input, {
        userId: user.id, sessionId: session.id, issuedAt: state.freshTime.getTime() / 1000,
        idleDeadline: session.lastActiveAt.getTime() / 1000 + idleSeconds,
      })
      return { accessToken: 'test-access-placeholder', issuedAt: input.issuedAt,
        expiresAt: Math.min(input.issuedAt + 900, input.idleDeadline) }
    },
  }
  return { deps, state, user, session, token, bytes, raw, events, inserted }
}

export async function failure(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert(error instanceof Error)
    assert.equal((error as Error & { code: string }).code, code)
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(String(error.stack), /private detail/)
    return true
  })
}
