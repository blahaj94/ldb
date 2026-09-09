import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { digest, failure, fixture, idleSeconds, load, time } from './refresh.fixtures.js'

test('refresh validates canonical 32 decoded bytes before any database work', async () => {
  const { rotateRefresh } = await load()
  const bytes = randomBytes(32)
  const canonical = bytes.toString('base64url')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const noncanonical = canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.at(-1)!) + 1]
  for (const value of [
    null,
    {},
    1,
    '',
    canonical + '=',
    ' ' + canonical,
    canonical + '\n',
    '+'.repeat(43),
    '/'.repeat(43),
    noncanonical,
    randomBytes(31).toString('base64url'),
    randomBytes(33).toString('base64url'),
    digest(bytes),
    { refreshToken: canonical, sessionId: randomUUID() }
  ]) {
    const f = fixture()
    await failure(rotateRefresh(f.deps, value), 'INVALID_AUTH_REQUEST')
    assert.deepEqual(f.events, [])
  }
})

test('rotation hashes decoded bytes, locks in order and returns only after commit', async () => {
  const { rotateRefreshForTest } = await load()
  const f = fixture()
  const bytes = randomBytes(32)
  let commitStarted!: () => void
  const committing = new Promise<void>((resolve) => {
    commitStarted = resolve
  })
  let releaseCommit!: () => void
  const release = new Promise<void>((resolve) => {
    releaseCommit = resolve
  })
  f.state.beforeCommit = async () => {
    commitStarted()
    await release
  }
  let returned = false
  const pending = rotateRefreshForTest(f.deps, f.raw, (size) => {
    assert.equal(size, 32)
    return bytes
  }).then((value) => {
    returned = true
    return value
  })
  await committing
  assert.equal(returned, false)
  releaseCommit()
  const result = await pending
  assert.equal(result.refreshToken, bytes.toString('base64url'))
  assert.equal(result.tokenType, 'Bearer')
  assert.equal(result.accessTokenExpiresAt, new Date(time.getTime() + 900_000).toISOString())
  assert.equal(result.sessionExpiresAt, new Date(time.getTime() + idleSeconds * 1000).toISOString())
  assert.deepEqual(f.inserted, [
    { tokenHash: digest(bytes), sessionId: f.session.id, issuedAt: time, consumedAt: null }
  ])
  assert.equal(f.token.consumedAt, time)
  assert.equal(f.session.lastActiveAt, time)
  assert.deepEqual(f.events, [
    'begin',
    'refresh-hint',
    'session-hint',
    'user-lock',
    'session-lock',
    'refresh-lock',
    'fresh-time',
    'sign',
    'consume',
    'insert',
    'commit'
  ])
})

test('consumed reuse commits session revocation before the rejection escapes', async () => {
  const { rotateRefresh } = await load()
  const f = fixture()
  f.token.consumedAt = time
  await failure(rotateRefresh(f.deps, f.raw), 'AUTHENTICATION_REQUIRED')
  assert.equal(f.session.revokedReason, 'refresh_reuse')
  assert.deepEqual(f.events.slice(-2), ['revoke', 'commit'])
  const hasRolledBack = f.events.includes('rollback')
  assert.equal(hasRolledBack, false)
  const hasSignedToken = f.events.includes('sign')
  assert.equal(hasSignedToken, false)
})

test('unknown, removed and stale ownership hints cannot select or revoke a session', async () => {
  const { rotateRefresh } = await load()
  for (const scenario of [
    'hintMissing',
    'userMissing',
    'sessionMissing',
    'tokenMissing',
    'session-owner',
    'token-owner'
  ]) {
    const f = fixture()
    f.token.consumedAt = time
    const shouldChangeSessionOwner = scenario === 'session-owner'
    const shouldChangeTokenOwner = !shouldChangeSessionOwner && scenario === 'token-owner'
    if (shouldChangeSessionOwner) {
      f.state.beforeLockedRead = () => {
        f.session.userId = randomUUID()
      }
    } else if (shouldChangeTokenOwner) {
      f.state.beforeLockedRead = () => {
        f.token.sessionId = randomUUID()
      }
    } else {
      Object.assign(f.state, { [scenario]: true })
    }
    await failure(rotateRefresh(f.deps, f.raw), 'AUTHENTICATION_REQUIRED')
    assert.equal(f.session.revokedAt, null)
    const hasSignedToken = f.events.includes('sign')
    assert.equal(hasSignedToken, false)
    const hasRevokedSession = f.events.includes('revoke')
    assert.equal(hasRevokedSession, false)
  }
})

test('exact idle deadline, expired and revoked sessions never issue or revive', async () => {
  const { rotateRefresh } = await load()
  for (const offset of [0, 1]) {
    const f = fixture()
    f.state.freshTime = new Date(time.getTime() + (idleSeconds + offset) * 1000)
    await failure(rotateRefresh(f.deps, f.raw), 'AUTHENTICATION_REQUIRED')
    assert.equal(f.token.consumedAt, null)
    assert.equal(f.session.lastActiveAt, time)
    const hasSignedToken = f.events.includes('sign')
    assert.equal(hasSignedToken, false)
  }
  const f = fixture()
  f.session.revokedAt = time
  f.session.revokedReason = 'logout'
  f.token.consumedAt = time
  await failure(rotateRefresh(f.deps, f.raw), 'AUTHENTICATION_REQUIRED')
  assert.equal(f.session.revokedReason, 'logout')
})

test('one second before idle deadline JWT is capped without extending activity', async () => {
  const { rotateRefresh } = await load()
  const f = fixture()
  f.state.freshTime = new Date(time.getTime() + (idleSeconds - 1) * 1000)
  const result = await rotateRefresh(f.deps, f.raw)
  assert.equal(result.accessTokenExpiresAt, result.sessionExpiresAt)
  assert.equal(f.session.lastActiveAt, time)
})

test('signing, entropy, insert and commit failures sanitize and rollback without retry', async () => {
  const { rotateRefreshForTest } = await load()
  for (const scenario of ['sign', 'entropy', 'insert', 'commit']) {
    const f = fixture()
    const explode = () => {
      throw new Error('private detail')
    }
    const shouldFailSigning = scenario === 'sign'
    if (shouldFailSigning) {
      f.deps.issueAccessJwt = explode
    }
    const shouldFailInsert = scenario === 'insert'
    if (shouldFailInsert) {
      f.state.beforeInsert = explode
    }
    const shouldFailCommit = scenario === 'commit'
    if (shouldFailCommit) {
      f.state.beforeCommit = explode
    }
    const shouldFailEntropy = scenario === 'entropy'
    const operation = rotateRefreshForTest(f.deps, f.raw, shouldFailEntropy ? explode : randomBytes)
    const isEntropyFailure = scenario === 'entropy'
    const isSigningFailure = !isEntropyFailure && scenario === 'sign'
    const isInternalFailure = isEntropyFailure || isSigningFailure
    await failure(operation, isInternalFailure ? 'AUTH_INTERNAL_ERROR' : 'AUTH_UNAVAILABLE')
    assert.equal(f.token.consumedAt, null)
    assert.equal(f.inserted.length, 0)
    assert.equal(f.events.filter((event) => event === 'begin').length, 1)
    assert.equal(f.events.at(-1), 'rollback')
  }
})
