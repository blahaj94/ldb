import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'

const { rotateRefreshForTest } = await import('../dist/auth/refresh/index.js')
const { logoutSession } = await import('../dist/auth/logout/index.js')
const rawToken = randomBytes(32).toString('base64url')
const ids = { user: randomUUID(), session: randomUUID() }
const repository = (overrides = {}) => ({
  findOneBy: async () => null,
  findOne: async () => null,
  update: async () => undefined,
  insert: async () => undefined,
  ...overrides
})
function dataSource({ users, sessions, refresh }) {
  const repositories = { User: users, AuthSession: sessions, AuthRefreshToken: refresh }
  return {
    transaction: async (_isolation, callback) =>
      callback({
        getRepository: (schema) => repositories[schema.options.name],
        query: async () => [{ now: new Date('2026-01-01T00:00:00Z') }]
      })
  }
}

for (const [name, session, token, expectedOwnerReads, expectedHashReads] of [
  ['locked session absent', null, { sessionId: ids.session }, 0, 0],
  ['locked token absent', { id: ids.session, userId: ids.user }, null, 0, 0],
  [
    'session owner mismatch',
    { id: ids.session, userId: randomUUID() },
    { sessionId: ids.session },
    0,
    0
  ],
  ['token owner mismatch', { id: ids.session, userId: ids.user }, { sessionId: randomUUID() }, 1, 0]
]) {
  test(`refresh preserves dependent evaluation after ${name}`, async () => {
    let tokenOwnerReads = 0
    let hashReads = 0
    const inspectedToken = token && {
      get sessionId() {
        tokenOwnerReads++
        return token.sessionId
      },
      get tokenHash() {
        hashReads++
        return { equals: () => true }
      }
    }
    const users = repository({ findOne: async () => ({ id: ids.user }) })
    const sessions = repository({
      findOneBy: async () => ({ id: ids.session, userId: ids.user }),
      findOne: async () => session
    })
    const refresh = repository({
      findOneBy: async () => ({ sessionId: ids.session }),
      findOne: async () => inspectedToken
    })
    let issueCalls = 0
    const deps = {
      dataSource: dataSource({ users, sessions, refresh }),
      issueAccessJwt: async () => {
        issueCalls++
        throw new Error('issueAccessJwt must not run')
      }
    }
    await assert.rejects(() => rotateRefreshForTest(deps, rawToken, () => Buffer.alloc(32)), {
      code: 'AUTHENTICATION_REQUIRED'
    })
    assert.equal(issueCalls, 0)
    assert.equal(tokenOwnerReads, expectedOwnerReads)
    assert.equal(hashReads, expectedHashReads)
  })
}

test('refresh executes the locked hash comparison for matching owners', async () => {
  let hashReads = 0
  let equalsCalls = 0
  let issueCalls = 0
  let updateCalls = 0
  let insertCalls = 0
  const token = {
    sessionId: ids.session,
    consumedAt: null,
    get tokenHash() {
      hashReads++
      return {
        equals: () => {
          equalsCalls++
          return false
        }
      }
    }
  }
  const session = {
    id: ids.session,
    userId: ids.user,
    lastActiveAt: new Date('2026-01-01T00:00:00Z'),
    revokedAt: null
  }
  const users = repository({ findOne: async () => ({ id: ids.user }) })
  const sessions = repository({
    findOneBy: async () => session,
    findOne: async () => session,
    update: async () => {
      updateCalls++
    }
  })
  const refresh = repository({
    findOneBy: async () => ({ sessionId: ids.session }),
    findOne: async () => token,
    update: async () => {
      updateCalls++
    },
    insert: async () => {
      insertCalls++
    }
  })
  const deps = {
    dataSource: dataSource({ users, sessions, refresh }),
    issueAccessJwt: async () => {
      issueCalls++
      throw new Error('issueAccessJwt must not run')
    }
  }
  await assert.rejects(() => rotateRefreshForTest(deps, rawToken, () => Buffer.alloc(32)), {
    code: 'AUTHENTICATION_REQUIRED'
  })
  assert.equal(hashReads, 1)
  assert.equal(equalsCalls, 1)
  assert.equal(issueCalls, 0)
  assert.equal(updateCalls, 0)
  assert.equal(insertCalls, 0)
})

for (const [name, session, token, expectedOwnerReads, expectedHashCalls] of [
  ['locked session absent', null, { sessionId: ids.session }, 1, 1],
  [
    'session owner mismatch',
    { id: ids.session, userId: randomUUID() },
    { sessionId: ids.session },
    1,
    1
  ],
  [
    'token owner mismatch',
    { id: ids.session, userId: ids.user },
    { sessionId: randomUUID() },
    1,
    1
  ],
  ['locked token absent', { id: ids.session, userId: ids.user }, null, 0, 0]
]) {
  test(`logout target evaluation is preserved for ${name}`, async () => {
    let ownerReads = 0
    let hashCalls = 0
    const inspectedToken = token && {
      get sessionId() {
        ownerReads++
        return token.sessionId
      },
      tokenHash: {
        equals() {
          hashCalls++
          return false
        }
      }
    }
    const users = repository({ findOne: async () => ({ id: ids.user }) })
    const sessions = repository({
      findOneBy: async () => ({ id: ids.session, userId: ids.user }),
      findOne: async () => session
    })
    const refresh = repository({
      findOneBy: async () => ({ sessionId: ids.session }),
      findOne: async () => inspectedToken
    })
    await logoutSession(dataSource({ users, sessions, refresh }), rawToken)
    assert.equal(ownerReads, expectedOwnerReads)
    assert.equal(hashCalls, expectedHashCalls)
  })
}
