import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { atExactTime, databaseNow } from './login-test-control.mjs'
import { digest, fixture, idleSeconds, opaque, rejected, setDeadline, stored } from './refresh-fixtures.mjs'

async function assertRotationHistory(source) {
  const before = await source.query('SELECT * FROM auth_refresh_tokens ORDER BY token_hash')
  const f = await fixture(source)
  const otherDevice = await fixture(source, f.identity)
  const unrelatedUser = await fixture(source)
  const otherBefore = await stored(source, otherDevice.initial.session.id)
  const unrelatedBefore = await stored(source, unrelatedUser.initial.session.id)
  // 30일보다 오래된 session과 발급 hash도 최근 활동이 있으면 보존하며 rotation할 수 있다.
  const oldIssuedAt = new Date((await databaseNow(source)).getTime() - 40 * 86_400_000)
  await source.query('UPDATE auth_sessions SET created_at=$2 WHERE id=$1', [f.initial.session.id, oldIssuedAt])
  await source.query('UPDATE auth_refresh_tokens SET issued_at=$2 WHERE token_hash=$1', [digest(f.initial.refreshToken), oldIssuedAt])
  const initial = await stored(source, f.initial.session.id)
  let raw = f.initial.refreshToken
  const hashes = [digest(raw)]
  for (let index = 0; index < 4; index++) {
    const result = await f.rotate(raw)
    assert.equal(result.tokenType, 'Bearer')
    const decoded = Buffer.from(result.refreshToken, 'base64url')
    assert.equal(decoded.length, 32)
    assert.equal(decoded.toString('base64url') === result.refreshToken, true)
    assert.equal(result.refreshToken === raw, false)
    const hash = digest(result.refreshToken)
    hashes.push(hash)
    const state = await stored(source, f.initial.session.id)
    const current = state.tokens.find((token) => token.token_hash.equals(hash))
    assert(current)
    assert.equal(current.issued_at.getTime() % 1000, 0)
    assert.equal(current.consumed_at, null)
    assert.equal(state.tokens.filter((token) => token.consumed_at === null).length, 1)
    assert.equal(state.tokens.length, index + 2)
    assert.deepEqual(state.session, initial.session)
    const principal = await f.verifyJwt(result.accessToken, current.issued_at.getTime() / 1000)
    assert.equal(principal.userId, f.initial.user.id)
    assert.equal(principal.sessionId, f.initial.session.id)
    assert.equal(principal.expiresAt - principal.issuedAt, 900)
    assert.equal(result.accessTokenExpiresAt, new Date(principal.expiresAt * 1000).toISOString())
    assert.equal(result.sessionExpiresAt, new Date(initial.session.last_active_at.getTime() + idleSeconds * 1000).toISOString())
    raw = result.refreshToken
  }
  const rotated = await stored(source, f.initial.session.id)
  assert(hashes.every((hash) => rotated.tokens.some((token) => token.token_hash.equals(hash))))
  await rejected(() => f.rotate(opaque()))
  assert.deepEqual(await stored(source, f.initial.session.id), rotated)
  await rejected(() => f.rotate(f.initial.refreshToken))
  const revoked = await stored(source, f.initial.session.id)
  assert.equal(revoked.session.revoked_reason, 'refresh_reuse')
  assert.deepEqual(revoked.tokens, rotated.tokens)
  await rejected(() => f.rotate(raw))
  assert.deepEqual(await stored(source, otherDevice.initial.session.id), otherBefore)
  assert.deepEqual(await stored(source, unrelatedUser.initial.session.id), unrelatedBefore)
  await otherDevice.rotate(otherDevice.initial.refreshToken)
  for (const token of before) {
    const [after] = await source.query('SELECT * FROM auth_refresh_tokens WHERE token_hash=$1', [token.token_hash])
    assert.deepEqual(after, token)
  }
}

async function assertBoundary(source) {
  for (const offset of [-1, 0, 1]) {
    const f = await fixture(source)
    const initial = await stored(source, f.initial.session.id)
    const deadline = new Date(initial.session.last_active_at.getTime() + idleSeconds * 1000)
    await atExactTime(source, new Date(deadline.getTime() + offset * 1000), async () => {
      if (offset >= 0) await rejected(() => f.rotate(f.initial.refreshToken))
      else {
        const result = await f.rotate(f.initial.refreshToken)
        assert.equal(result.accessTokenExpiresAt, deadline.toISOString())
        const principal = await f.verifyJwt(result.accessToken, deadline.getTime() / 1000 - 1)
        assert.equal(principal.expiresAt - principal.issuedAt, 1)
      }
    })
    const after = await stored(source, f.initial.session.id)
    assert.deepEqual(after.session, initial.session)
    if (offset >= 0) assert.deepEqual(after.tokens, initial.tokens)
  }
  // 현재 DB 시각으로 이미 만료된 consumed token도 reuse 쓰기로 session을 바꾸지 않는다.
  const expired = await fixture(source)
  await expired.rotate(expired.initial.refreshToken)
  await setDeadline(source, expired.initial.session.id, await databaseNow(source))
  const before = await stored(source, expired.initial.session.id)
  await rejected(() => expired.rotate(expired.initial.refreshToken))
  assert.deepEqual(await stored(source, expired.initial.session.id), before)
}

export async function assertRefreshRotation(source, mark) {
  const cases = [
    ['decoded hash, JWT, full history and other devices', assertRotationHistory],
    ['exact idle boundary and expired consumed token', assertBoundary],
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run(source)
  }
  return cases.length
}
