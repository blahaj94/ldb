import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkedAt,
  cleanupFixture,
  idleMilliseconds,
  request,
  session
} from './cleanup-fixtures.mjs'

const load = () => import('../dist/auth/cleanup/index.js')

for (const [name, patch, expected] of [
  ['active', {}, 0],
  [
    'one second before idle deadline',
    { lastActiveAt: new Date(checkedAt.getTime() - idleMilliseconds + 1000) },
    0
  ],
  ['exact idle deadline', { lastActiveAt: new Date(checkedAt.getTime() - idleMilliseconds) }, 1],
  [
    'after idle deadline',
    { lastActiveAt: new Date(checkedAt.getTime() - idleMilliseconds - 1000) },
    1
  ],
  ['revoked', { revokedAt: checkedAt, revokedReason: 'logout' }, 1]
]) {
  test(`cleanup session eligibility: ${name}`, async () => {
    const { cleanupAuthentication } = await load()
    const row = session(patch)
    const f = cleanupFixture({ sessions: [row] })
    const result = await cleanupAuthentication(f.source)
    assert.equal(result.sessionsDeleted, expected)
    assert.equal(f.deleted.sessions.length, expected)
    assert.deepEqual(f.events.slice(0, 2), ['lock', 'fresh-time'])
  })
}

for (const [name, patch, expected] of [
  ['valid processing', {}, 0],
  ['exact request deadline', { expiresAt: checkedAt }, 1],
  ['consumed', { status: 'consumed' }, 1],
  ['failed', { status: 'failed' }, 1],
  [
    'valid exchange',
    { status: 'exchange_ready', codeExpiresAt: new Date(checkedAt.getTime() + 1000) },
    0
  ],
  [
    'expired code remains until request TTL or terminal transition',
    { status: 'exchange_ready', codeExpiresAt: checkedAt },
    0
  ]
]) {
  test(`cleanup OAuth eligibility: ${name}`, async () => {
    const { cleanupAuthentication } = await load()
    const row = request(patch)
    const f = cleanupFixture({ requests: [row] })
    const result = await cleanupAuthentication(f.source)
    assert.equal(result.loginRequestsDeleted, expected)
    assert.equal(f.deleted.requests.length, expected)
  })
}

test('candidate is only a hint: activity, ownership change and disappearance are reread under lock', async () => {
  const { cleanupAuthentication } = await load()
  for (const change of ['activity', 'ownership', 'removed']) {
    const row = session({ lastActiveAt: new Date(checkedAt.getTime() - idleMilliseconds) })
    const f = cleanupFixture({
      sessions: [row],
      beforeLock: (rows) => {
        const isActivity = change === 'activity'
        const isOwnership = change === 'ownership'
        if (isActivity) {
          row.lastActiveAt = checkedAt
        } else if (isOwnership) {
          row.userId = session().userId
        } else {
          rows.pop()
        }
      }
    })
    assert.equal((await cleanupAuthentication(f.source)).sessionsDeleted, 0)
    assert.deepEqual(f.deleted.sessions, [])
  }
})

test('empty cleanup succeeds without owning or closing caller DataSource', async () => {
  const { cleanupAuthentication } = await load()
  const f = cleanupFixture()
  assert.deepEqual(await cleanupAuthentication(f.source), {
    sessionsDeleted: 0,
    loginRequestsDeleted: 0
  })
  assert.deepEqual(await cleanupAuthentication(f.source), {
    sessionsDeleted: 0,
    loginRequestsDeleted: 0
  })
  assert.deepEqual(f.events, [])
})

test('later transaction failure cannot report success or erase earlier confirmed commits', async () => {
  const { cleanupAuthentication } = await load()
  const f = cleanupFixture({
    sessions: [session({ revokedAt: checkedAt }), session({ revokedAt: checkedAt })],
    beforeCommit: (number) => {
      const shouldFail = number === 2
      if (shouldFail) {
        throw new Error('fixture-private SQL detail')
      }
    }
  })
  await assert.rejects(cleanupAuthentication(f.source), (error) => {
    assert.equal(error.message, 'Authentication cleanup failed')
    assert.equal(error.stack, 'Error: Authentication cleanup failed')
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(f.deleted.sessions.length, 1)
})

test('lost commit acknowledgement fails even when deletion committed', async () => {
  const { cleanupAuthentication } = await load()
  const f = cleanupFixture({
    sessions: [session({ revokedAt: checkedAt, revokedReason: 'logout' })],
    afterCommit: () => {
      throw new Error('fixture-private commit response lost')
    }
  })
  await assert.rejects(cleanupAuthentication(f.source), {
    message: 'Authentication cleanup failed'
  })
  assert.equal(f.deleted.sessions.length, 1)
})
