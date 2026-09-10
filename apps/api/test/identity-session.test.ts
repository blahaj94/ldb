import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { EntityManager } from 'typeorm'
import { UserSchema } from '../src/database/schemas/users.js'
import { AuthSessionSchema } from '../src/database/schemas/auth-sessions.js'
import { AuthRefreshTokenSchema } from '../src/database/schemas/auth-refresh-tokens.js'

interface Identity {
  provider: 'google' | 'discord'
  subject: string
}
interface Result {
  user: { id: string; nickname: string }
  session: { id: string; createdAt: Date; lastActiveAt: Date }
  refreshToken: string
  isNewUser: boolean
}
interface Entropy {
  uuid(): string
  nicknameNumber(min: number, max: number): number
  refreshBytes(size: number): Buffer
}
interface SessionModule {
  createIdentitySession(manager: EntityManager, identity: Identity): Promise<Result>
  createIdentitySessionForTest(
    manager: EntityManager,
    identity: Identity,
    entropy: Partial<Entropy>
  ): Promise<Result>
}
async function load(): Promise<SessionModule> {
  return import(
    new URL('../src/auth/identity-session.js', import.meta.url).href
  ) as Promise<SessionModule>
}
const identity: Identity = { provider: 'google', subject: 'test-subject' }
const time = new Date('2026-09-06T00:00:10Z')
const existing = {
  id: '00000000-0000-4000-8000-000000000001',
  nickname: '기존 👩‍💻',
  createdAt: new Date('2026-01-01Z')
}

function fixture(
  options: { existing?: boolean; missing?: boolean; isolation?: string; active?: boolean } = {}
) {
  const sessions: Record<string, unknown>[] = []
  const refresh: Record<string, unknown>[] = []
  const events: string[] = []
  let inserted: Record<string, unknown> | undefined
  const insertBuilder = {
    insert: () => insertBuilder,
    values: (value: Record<string, unknown>) => {
      inserted = { ...value, createdAt: time }
      return insertBuilder
    },
    orUpdate: () => insertBuilder,
    returning: () => insertBuilder,
    callListeners: () => insertBuilder,
    updateEntity: () => insertBuilder,
    execute: async () => {
      events.push('user-insert')
      const isUserMissing = options.missing === true
      return { raw: isUserMissing ? [] : [{ id: inserted?.id }] }
    }
  }
  const userRepository = {
    createQueryBuilder: () => insertBuilder,
    findOne: async (query: { where: unknown; lock: unknown }) => {
      assert.deepEqual(query.where, {
        provider: identity.provider,
        providerSubject: identity.subject
      })
      assert.deepEqual(query.lock, { mode: 'pessimistic_write' })
      events.push('user-lock')
      const isUserMissing = options.missing === true
      const hasExistingUser = !isUserMissing && options.existing === true
      return isUserMissing ? null : hasExistingUser ? { ...existing } : (inserted ?? null)
    },
    update: async (_where: unknown, values: Record<string, unknown>) => {
      events.push('user-time')
      Object.assign(inserted ?? {}, values)
    }
  }
  const manager = {
    queryRunner: { isTransactionActive: options.active ?? true },
    query: async (sql: string) => {
      const isIsolationQuery = sql.startsWith('SHOW')
      if (isIsolationQuery) {
        return [{ transaction_isolation: options.isolation ?? 'read committed' }]
      }
      assert.match(sql, /floor\(extract\(epoch from clock_timestamp\(\)\)\)/)
      events.push('fresh-time')
      return [{ now: time }]
    },
    getRepository: (schema: unknown) => {
      const isUserSchema = schema === UserSchema
      if (isUserSchema) {
        return userRepository
      }
      const isSessionSchema = schema === AuthSessionSchema
      if (isSessionSchema) {
        return {
          insert: async (value: Record<string, unknown>) => {
            events.push('session')
            sessions.push(value)
          }
        }
      }
      assert.equal(schema, AuthRefreshTokenSchema)
      return {
        insert: async (value: Record<string, unknown>) => {
          events.push('refresh')
          refresh.push(value)
        }
      }
    }
  } as unknown as EntityManager
  return { manager, sessions, refresh, events }
}

async function failure(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    const isError = error instanceof Error
    assert(isError)
    assert.equal((error as Error & { code: string }).code, code)
    assert.equal(error.cause, undefined)
    const isIdentityOmitted = !JSON.stringify(error).includes(identity.subject)
    assert(isIdentityOmitted)
    return true
  })
}

test('new identity gets padded nickname, fresh whole-second session and hash of decoded refresh bytes', async () => {
  const { createIdentitySessionForTest } = await load()
  for (const value of [0, 7, 999_999]) {
    const state = fixture()
    const bytes = Buffer.alloc(32, 250)
    const result = await createIdentitySessionForTest(state.manager, identity, {
      nicknameNumber: (min, max) => {
        assert.deepEqual([min, max], [0, 1_000_000])
        return value
      },
      refreshBytes: (size) => {
        assert.equal(size, 32)
        return bytes
      }
    })
    assert.equal(result.isNewUser, true)
    const nickname = result.user.nickname
    const nicknameSuffix = String(value).padStart(6, '0')
    const expectedNickname = `모험가${nicknameSuffix}`
    assert.equal(nickname, expectedNickname)
    assert.deepEqual(Object.keys(result.user).sort(), ['id', 'nickname'])
    assert.match(result.user.id, /^[0-9a-f-]{36}$/)
    assert.match(result.session.id, /^[0-9a-f-]{36}$/)
    assert.notEqual(result.user.id, result.session.id)
    assert.equal(result.refreshToken, bytes.toString('base64url'))
    assert.deepEqual(state.refresh, [
      {
        tokenHash: createHash('sha256').update(bytes).digest(),
        sessionId: result.session.id,
        issuedAt: time,
        consumedAt: null
      }
    ])
    assert.deepEqual(state.sessions, [
      {
        id: result.session.id,
        userId: result.user.id,
        createdAt: time,
        lastActiveAt: time,
        revokedAt: null,
        revokedReason: null
      }
    ])
    assert.deepEqual(state.events, [
      'user-lock',
      'user-insert',
      'user-lock',
      'fresh-time',
      'user-time',
      'session',
      'refresh'
    ])
  }
})

test('existing identity preserves nickname and creates independent sessions without nickname entropy', async () => {
  const { createIdentitySessionForTest } = await load()
  const state = fixture({ existing: true })
  const entropy = { nicknameNumber: () => assert.fail('existing nickname must be preserved') }
  const a = await createIdentitySessionForTest(state.manager, identity, entropy)
  const b = await createIdentitySessionForTest(state.manager, identity, entropy)
  assert.equal(a.isNewUser, false)
  assert.deepEqual(a.user, { id: existing.id, nickname: existing.nickname })
  assert.deepEqual(b.user, a.user)
  assert.notEqual(a.session.id, b.session.id)
  assert.notEqual(a.refreshToken, b.refreshToken)
  assert.equal(Buffer.from(a.refreshToken, 'base64url').length, 32)
  assert.equal(Buffer.from(a.refreshToken, 'base64url').toString('base64url'), a.refreshToken)
  assert.deepEqual(state.events, [
    'user-lock',
    'fresh-time',
    'session',
    'refresh',
    'user-lock',
    'fresh-time',
    'session',
    'refresh'
  ])
})

test('transaction and isolation preconditions reject before writing', async () => {
  const { createIdentitySession } = await load()
  for (const options of [
    { active: false },
    { isolation: 'repeatable read' },
    { isolation: 'serializable' }
  ]) {
    const state = fixture(options)
    await failure(createIdentitySession(state.manager, identity), 'AUTH_INTERNAL_ERROR')
    assert.deepEqual(state.events, [])
  }
})

test('invalid provider and subject reject before database access', async (t) => {
  const { createIdentitySession } = await load()
  for (const candidate of [
    { provider: 'other', subject: 'test-subject' },
    { provider: 'google', subject: 42 },
    { provider: 'google', subject: '' }
  ]) {
    const state = fixture()
    const query = t.mock.method(state.manager, 'query')
    const getRepository = t.mock.method(state.manager, 'getRepository')
    await failure(
      createIdentitySession(state.manager, candidate as Identity),
      'AUTH_INTERNAL_ERROR'
    )
    assert.equal(query.mock.callCount(), 0)
    assert.equal(getRepository.mock.callCount(), 0)
    assert.deepEqual(state.sessions, [])
    assert.deepEqual(state.refresh, [])
  }
})

test('a conflict without a visible user requires whole-transaction restart and creates no session', async () => {
  const { createIdentitySession } = await load()
  const state = fixture({ missing: true })
  await failure(createIdentitySession(state.manager, identity), 'AUTH_UNAVAILABLE')
  assert.deepEqual(state.sessions, [])
  assert.deepEqual(state.events, ['user-lock', 'user-insert', 'user-lock'])
})

test('database and entropy failures expose only sanitized errors', async () => {
  const { createIdentitySession, createIdentitySessionForTest } = await load()
  const state = fixture({ existing: true })
  state.manager.query = async () => {
    throw new Error(`private database detail ${identity.subject}`)
  }
  await failure(createIdentitySession(state.manager, identity), 'AUTH_UNAVAILABLE')
  const other = fixture({ existing: true })
  await failure(
    createIdentitySessionForTest(other.manager, identity, {
      refreshBytes: () => {
        throw new Error(`private entropy detail ${identity.subject}`)
      }
    }),
    'AUTH_INTERNAL_ERROR'
  )
  assert.deepEqual(other.sessions, [])
})
