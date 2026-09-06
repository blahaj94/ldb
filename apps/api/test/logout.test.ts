import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { logoutSession } from '../src/auth/logout/index.js'
import { checkedAt, logoutFixture } from './logout.fixtures.js'

async function expectUnavailable(operation: Promise<void>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    const isErrorObject = error != null && typeof error === 'object'
    if (!isErrorObject) return false
    assert('code' in error)
    assert.equal(error.code, 'AUTH_UNAVAILABLE')
    assert.equal('cause' in error, false)
    assert.doesNotMatch(String('stack' in error ? error.stack : ''), /private|credential|SQL/)
    return true
  })
}

async function expectInvalidRequest(operation: Promise<void>): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    const isErrorObject = error != null && typeof error === 'object'
    if (!isErrorObject) return false
    assert('code' in error)
    assert.equal(error.code, 'INVALID_AUTH_REQUEST')
    return true
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

test('logout rejects noncanonical refresh strings before database work', async () => {
  const canonical = randomBytes(32).toString('base64url')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const finalCharacter = canonical.at(-1)!
  const noncanonical = canonical.slice(0, -1) + alphabet[alphabet.indexOf(finalCharacter) + 1]
  for (const rawToken of [
    null,
    {},
    1,
    '',
    ' ',
    `${canonical}=`,
    noncanonical,
    randomBytes(31).toString('base64url'),
    randomBytes(33).toString('base64url'),
    '+'.repeat(43),
    '/'.repeat(43),
  ]) {
    const fixture = logoutFixture()
    await expectInvalidRequest(logoutSession(fixture.dataSource, rawToken))
    assert.deepEqual(fixture.events, [])
    assert.equal(fixture.session.revokedAt, null)
  }
})

test('logout locks a known current or consumed token session and resolves after commit', async () => {
  for (const isConsumed of [false, true]) {
    const fixture = logoutFixture()
    fixture.token.consumedAt = isConsumed ? checkedAt : null
    const commitStarted = deferred()
    const releaseCommit = deferred()
    fixture.state.beforeCommit = async () => {
      commitStarted.resolve()
      await releaseCommit.promise
    }

    let resolved = false
    const pending = logoutSession(fixture.dataSource, fixture.rawToken).then(() => {
      resolved = true
    })
    await commitStarted.promise
    assert.equal(resolved, false)
    assert.equal(fixture.session.revokedReason, 'logout')
    assert.equal(fixture.session.lastActiveAt.toISOString(), '2026-09-05T00:00:00.000Z')
    releaseCommit.resolve()
    await pending

    assert.equal(fixture.session.revokedAt, checkedAt)
    assert.deepEqual(fixture.events, [
      'begin',
      'refresh-hint',
      'session-hint',
      'user-lock',
      'session-lock',
      'refresh-lock',
      'fresh-time',
      'revoke',
      'commit',
    ])
  }
})

test('logout leaves ended, missing and stale ownership sessions unchanged', async () => {
  const scenarios = [
    'tokenHintMissing',
    'sessionHintMissing',
    'userMissing',
    'sessionMissing',
    'tokenMissing',
    'sessionOwnerChanged',
    'tokenOwnerChanged',
    'tokenHashChanged',
    'alreadyRevoked',
    'idleExpired',
  ] as const

  for (const scenario of scenarios) {
    const fixture = logoutFixture()
    if (scenario === 'sessionOwnerChanged') fixture.session.userId = randomUUID()
    else if (scenario === 'tokenOwnerChanged') fixture.token.sessionId = randomUUID()
    else if (scenario === 'tokenHashChanged') fixture.token.tokenHash = randomBytes(32)
    else if (scenario === 'alreadyRevoked') {
      fixture.session.revokedAt = checkedAt
      fixture.session.revokedReason = 'refresh_reuse'
    } else if (scenario === 'idleExpired') {
      fixture.session.lastActiveAt = new Date('2026-08-01T00:00:00.000Z')
    } else {
      fixture.state[scenario] = true
    }

    const before = structuredClone(fixture.session)
    await logoutSession(fixture.dataSource, fixture.rawToken)
    assert.deepEqual(fixture.session, before)
    assert.equal(fixture.events.includes('revoke'), false)
  }
})

test('logout sanitizes database and commit uncertainty without retry', async () => {
  for (const failurePoint of ['transaction', 'commit'] as const) {
    const fixture = logoutFixture()
    const rawError = new Error('private credential SQL detail')
    if (failurePoint === 'transaction') fixture.state.transactionFailure = rawError
    else fixture.state.commitFailure = rawError

    await expectUnavailable(logoutSession(fixture.dataSource, fixture.rawToken))
    assert.equal(fixture.events.filter((event) => event === 'begin').length, 1)
    assert.equal(fixture.events.includes('commit'), false)
  }
})
