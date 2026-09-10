import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'

const { rotateRefreshForTest } = await import('../dist/auth/refresh/index.js')
const { logoutSession } = await import('../dist/auth/logout/index.js')

const rawToken = randomBytes(32).toString('base64url')
const ids = { user: randomUUID(), session: randomUUID() }

function repository(overrides = {}) {
  return {
    findOneBy: async () => null,
    findOne: async () => null,
    update: async () => undefined,
    insert: async () => undefined,
    ...overrides
  }
}

function dataSource({ users, sessions, refresh }) {
  return {
    transaction: async (_isolation, callback) =>
      callback({
        getRepository: (() => {
          const repositories = [users, sessions, refresh]
          let index = 0
          return (schema) => {
            const byName = { User: users, AuthSession: sessions, AuthRefreshToken: refresh }
            return byName[schema.options.name] ?? repositories[index++]
          }
        })(),
        query: async () => [{ now: new Date('2026-01-01T00:00:00Z') }]
      })
  }
}

function throwingToken() {
  return {
    sessionId: ids.session,
    get tokenHash() {
      throw new Error('hash property inspected')
    }
  }
}

for (const [name, session] of [
  ['missing session', null],
  ['session owner mismatch', { userId: randomUUID(), id: ids.session }]
]) {
  test(`refresh skips dependent properties after ${name}`, async () => {
    const token = throwingToken()
    const users = repository({ findOne: async () => ({ id: ids.user }) })
    const sessions = repository({
      findOneBy: async () => ({ userId: ids.user, id: ids.session }),
      findOne: async () => session
    })
    const refresh = repository({ findOneBy: async () => token, findOne: async () => token })
    if (session) {
      sessions.findOne = async () => ({
        ...session,
        get userId() {
          return session.userId
        }
      })
    }
    await assert.rejects(
      () =>
        rotateRefreshForTest(dataSource({ users, sessions, refresh }), rawToken, () =>
          Buffer.alloc(32)
        ),
      (error) => ['AUTHENTICATION_REQUIRED', 'AUTH_UNAVAILABLE'].includes(error.code)
    )
  })
}

for (const [name, session, shouldInspect] of [
  ['missing session', null, true],
  ['session owner mismatch', { id: ids.session, userId: randomUUID() }, true],
  ['missing token', { id: ids.session, userId: ids.user }, false]
]) {
  test(`logout target inspection is preserved for ${name}`, async () => {
    let ownerReads = 0
    let hashCalls = 0
    const sessionValue = session && { ...session }
    const tokenValue = shouldInspect
      ? {
          get sessionId() {
            ownerReads++
            return ids.session
          },
          tokenHash: {
            equals() {
              hashCalls++
              return false
            }
          }
        }
      : null
    const users = repository({ findOne: async () => ({ id: ids.user }) })
    const sessions = repository({
      findOneBy: async () => ({ id: ids.session, userId: ids.user }),
      findOne: async () => sessionValue
    })
    const refresh = repository({
      findOneBy: async () => tokenValue,
      findOne: async () => tokenValue
    })
    await logoutSession(dataSource({ users, sessions, refresh }), rawToken)
    assert.equal(ownerReads, shouldInspect ? 2 : 0)
    assert.equal(hashCalls, shouldInspect ? 1 : 0)
  })
}
