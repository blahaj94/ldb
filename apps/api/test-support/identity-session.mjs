import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { AuthRefreshTokenSchema } from '../dist/database/schemas/auth-refresh-tokens.js'
import { AuthSessionSchema } from '../dist/database/schemas/auth-sessions.js'
import { UserSchema } from '../dist/database/schemas/users.js'
import { insertLogin, loginRequest } from './database-contract.mjs'

const digest = (token) => createHash('sha256').update(Buffer.from(token, 'base64url')).digest()
const identity = (subject = randomUUID(), provider = 'google') => ({ provider, subject })
const login = (source, create, input) => source.transaction('READ COMMITTED', (manager) => create(manager, input))

async function rows(source) {
  const result = {}
  for (const table of ['users', 'auth_sessions', 'auth_refresh_tokens', 'auth_login_requests']) {
    result[table] = await source.query(`SELECT * FROM "${table}" ORDER BY 1`)
  }
  return result
}

async function expectFailure(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code)
    assert.equal(error.cause, undefined)
    return true
  })
}

// 경과 시간 추측 대신 PostgreSQL이 관측한 blocker를 barrier로 사용한다.
async function blockedBy(source, waiter, blocker) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const [state] = await source.query('SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked', [waiter, blocker])
    if (state.blocked) return
    await setTimeout(10)
  }
  assert.fail('expected PostgreSQL lock contention')
}

async function runners(source, operation) {
  const a = source.createQueryRunner()
  const b = source.createQueryRunner()
  try {
    for (const runner of [a, b]) {
      await runner.connect()
      await runner.startTransaction('READ COMMITTED')
      await runner.query("SET LOCAL statement_timeout = '8s'")
    }
    const [{ pid: aPid }] = await a.query('SELECT pg_backend_pid() AS pid')
    const [{ pid: bPid }] = await b.query('SELECT pg_backend_pid() AS pid')
    await operation(a, b, aPid, bPid)
  } finally {
    // 대기 중인 두 번째 connection보다 blocker를 먼저 해제한다.
    for (const runner of [a, b]) {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await runner.release()
    }
  }
}

async function consumeFixture(manager, request) {
  await manager.query('SELECT id FROM auth_login_requests WHERE id = $1 FOR UPDATE', [request.id])
  const consumed = loginRequest('consumed', request.id)
  const columns = Object.keys(consumed).filter((column) => column !== 'id')
  await manager.query(
    `UPDATE auth_login_requests SET ${columns.map((column, i) => `"${column}" = $${i + 2}`).join(', ')} WHERE id = $1`,
    [request.id, ...columns.map((column) => consumed[column])],
  )
}

async function assertStored(source, result) {
  const user = await source.getRepository(UserSchema).findOneByOrFail({ id: result.user.id })
  const session = await source.getRepository(AuthSessionSchema).findOneByOrFail({ id: result.session.id })
  const refresh = await source.getRepository(AuthRefreshTokenSchema).findBy({ sessionId: result.session.id })
  assert.equal(refresh.length, 1)
  assert.equal(session.userId, user.id)
  assert.equal(session.revokedAt, null)
  assert.equal(session.revokedReason, null)
  assert.equal(session.createdAt.getTime(), result.session.createdAt.getTime())
  assert.equal(session.lastActiveAt.getTime(), session.createdAt.getTime())
  assert.equal(session.createdAt.getTime() % 1_000, 0)
  assert.equal(refresh[0].issuedAt.getTime(), session.createdAt.getTime())
  assert.equal(refresh[0].consumedAt, null)
  assert.deepEqual(refresh[0].tokenHash, digest(result.refreshToken))
  assert.equal(Buffer.from(result.refreshToken, 'base64url').length, 32)
  assert.equal(Buffer.from(result.refreshToken, 'base64url').toString('base64url'), result.refreshToken)
  assert.deepEqual(Object.keys(refresh[0]).sort(), ['consumedAt', 'issuedAt', 'sessionId', 'tokenHash'])
  if (result.isNewUser) assert.equal(user.createdAt.getTime(), session.createdAt.getTime())
}

export async function assertIdentitySessions(source, mark = () => undefined) {
  const { createIdentitySession: create, createIdentitySessionForTest: createForTest } =
    await import('../dist/auth/identity-session.js')
  const original = await rows(source)

  mark('new and existing data preservation')
  const input = identity()
  const first = await login(source, create, input)
  assert.equal(first.isNewUser, true)
  assert.match(first.user.nickname, /^모험가[0-9]{6}$/)
  await assertStored(source, first)
  await source.getRepository(UserSchema).update({ id: first.user.id }, { nickname: '기존 👩‍💻 닉네임' })
  const second = await login(source, create, input)
  const third = await login(source, create, input)
  // 한 기기의 소비 이력, 폐기된 기기, idle 기기를 모두 보존한다.
  await source.getRepository(AuthRefreshTokenSchema).update(
    { sessionId: first.session.id }, { consumedAt: first.session.createdAt },
  )
  await source.getRepository(AuthRefreshTokenSchema).insert({
    tokenHash: randomBytes(32), sessionId: first.session.id, issuedAt: first.session.createdAt, consumedAt: null,
  })
  await source.getRepository(AuthSessionSchema).update({ id: second.session.id }, {
    revokedAt: second.session.createdAt, revokedReason: 'logout',
  })
  const old = new Date('2025-01-01T00:00:00Z')
  await source.getRepository(AuthSessionSchema).update({ id: third.session.id }, { createdAt: old, lastActiveAt: old })
  const beforeExisting = await rows(source)
  const again = await login(source, create, input)
  assert.equal(again.isNewUser, false)
  assert.equal(again.user.id, first.user.id)
  assert.equal(again.user.nickname, '기존 👩‍💻 닉네임')
  await assertStored(source, again)
  const afterExisting = await rows(source)
  assert.deepEqual(afterExisting.users, beforeExisting.users)
  assert.deepEqual(afterExisting.auth_sessions.filter((row) => row.id !== again.session.id), beforeExisting.auth_sessions)
  assert.deepEqual(afterExisting.auth_refresh_tokens.filter((row) => row.session_id !== again.session.id), beforeExisting.auth_refresh_tokens)

  mark('opaque identity and duplicate nickname')
  const prefix = randomUUID()
  const inputs = [identity(`${prefix}Ab001`), identity(`${prefix}ab001`), identity(`${prefix}Ab001`, 'discord'),
    identity(`${prefix}0009007199254740993`), identity(`${prefix}9007199254740993`), identity(` ${prefix}Ab001 `)]
  const distinct = []
  for (const item of inputs) {
    distinct.push(await login(source, (manager, value) => createForTest(manager, value, { nicknameNumber: () => 7 }), item))
  }
  assert.equal(new Set(distinct.map((result) => result.user.id)).size, inputs.length)
  assert(distinct.every((result) => result.isNewUser && result.user.nickname === '모험가000007'))
  for (let index = 0; index < inputs.length; index++) {
    const stored = await source.getRepository(UserSchema).findOneByOrFail({ id: distinct[index].user.id })
    assert.equal(stored.providerSubject, inputs[index].subject)
  }

  mark('concurrent insert winner and separate loser snapshot')
  const concurrent = identity()
  await runners(source, async (a, b, aPid, bPid) => {
    const winner = await create(a.manager, concurrent)
    const pending = create(b.manager, concurrent)
    pending.catch(() => undefined)
    await blockedBy(source, bPid, aPid)
    await a.commitTransaction()
    const loser = await pending
    await b.commitTransaction()
    assert.equal(winner.isNewUser, true)
    assert.equal(loser.isNewUser, false)
    assert.deepEqual(loser.user, winner.user)
    assert.notEqual(loser.session.id, winner.session.id)
    assert.notEqual(loser.refreshToken, winner.refreshToken)
    assert.equal(await source.getRepository(UserSchema).countBy({ provider: concurrent.provider, providerSubject: concurrent.subject }), 1)
    await assertStored(source, winner)
    await assertStored(source, loser)
  })

  mark('rolled-back insert contender becomes actual winner')
  await runners(source, async (a, b, aPid, bPid) => {
    const value = identity()
    const rolledBack = await create(a.manager, value)
    const pending = create(b.manager, value)
    pending.catch(() => undefined)
    await blockedBy(source, bPid, aPid)
    await a.rollbackTransaction()
    const winner = await pending
    await b.commitTransaction()
    assert.equal(winner.isNewUser, true)
    assert.notEqual(winner.user.id, rolledBack.user.id)
    assert.equal(await source.getRepository(UserSchema).countBy({ id: rolledBack.user.id }), 0)
    await assertStored(source, winner)
  })

  mark('existing user lock precedes fresh database time')
  await runners(source, async (a, b, aPid, bPid) => {
    await a.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [first.user.id])
    // Clock boundary를 DB에서 넘겨 transaction 시작 시각 재사용을 식별한다.
    await a.query('SELECT pg_sleep(1.05)')
    const pending = create(b.manager, input)
    pending.catch(() => undefined)
    await blockedBy(source, bPid, aPid)
    const [{ minimum }] = await a.query('SELECT to_timestamp(floor(extract(epoch from clock_timestamp()))) AS minimum')
    await a.commitTransaction()
    const result = await pending
    await b.commitTransaction()
    const [{ maximum }] = await source.query('SELECT clock_timestamp() AS maximum')
    assert(result.session.createdAt >= minimum)
    assert(result.session.createdAt <= maximum)
    await assertStored(source, result)
  })

  mark('caller code consumption commits with identity session')
  const request = loginRequest('exchange_ready', randomUUID(), { exchange_code_hash: randomBytes(32) })
  await insertLogin(source, request)
  const composed = await source.transaction('READ COMMITTED', async (manager) => {
    await consumeFixture(manager, request)
    const result = await create(manager, identity())
    // Commit 전 다른 connection에서는 새 회원·session이 보이지 않는다.
    assert.equal(await source.getRepository(UserSchema).countBy({ id: result.user.id }), 0)
    assert.equal(await source.getRepository(AuthSessionSchema).countBy({ id: result.session.id }), 0)
    return result
  })
  const [consumed] = await source.query('SELECT * FROM auth_login_requests WHERE id = $1', [request.id])
  assert.equal(consumed.status, 'consumed')
  assert.equal(consumed.exchange_code_hash, null)
  assert.equal(consumed.verified_subject, null)
  await assertStored(source, composed)

  mark('all writes roll back on caller session refresh and entropy failures')
  const rollbackRequest = loginRequest('exchange_ready', randomUUID(), { exchange_code_hash: randomBytes(32) })
  await insertLogin(source, rollbackRequest)
  const beforeFailures = await rows(source)
  const variants = [
    { code: 'CALLER_FAILURE', run: async (manager) => { await create(manager, identity()); throw Object.assign(new Error('caller failed'), { code: 'CALLER_FAILURE' }) } },
    { code: 'AUTH_UNAVAILABLE', run: async (manager) => {
      let calls = 0
      return createForTest(manager, identity(), { uuid: () => ++calls === 1 ? randomUUID() : first.session.id })
    } },
    { code: 'AUTH_UNAVAILABLE', run: (manager) => createForTest(manager, identity(), { refreshBytes: () => Buffer.from(again.refreshToken, 'base64url') }) },
    { code: 'AUTH_INTERNAL_ERROR', run: (manager) => createForTest(manager, identity(), { refreshBytes: () => { throw new Error('entropy failed') } }) },
    { code: 'AUTH_UNAVAILABLE', run: (manager) => createForTest(manager, input, { refreshBytes: () => Buffer.from(again.refreshToken, 'base64url') }) },
  ]
  for (const variant of variants) {
    await expectFailure(source.transaction('READ COMMITTED', async (manager) => {
      await consumeFixture(manager, rollbackRequest)
      await variant.run(manager)
    }), variant.code)
    assert.deepEqual(await rows(source), beforeFailures)
  }
  // 충돌 후 새 transaction과 새 entropy로 정상 발급한다.
  await assertStored(source, await login(source, create, identity()))

  mark('transaction preconditions leave database unchanged')
  const beforeGuards = await rows(source)
  await expectFailure(create(source.manager, identity()), 'AUTH_INTERNAL_ERROR')
  await expectFailure(source.transaction('REPEATABLE READ', (manager) => create(manager, identity())), 'AUTH_INTERNAL_ERROR')
  assert.deepEqual(await rows(source), beforeGuards)

  mark('pre-existing fixture rows remain intact')
  const final = await rows(source)
  for (const table of Object.keys(original)) {
    const key = table === 'auth_refresh_tokens' ? 'token_hash' : 'id'
    const ids = new Set(original[table].map((row) => String(row[key])))
    assert.deepEqual(final[table].filter((row) => ids.has(String(row[key]))), original[table])
  }
  return { scenarios: 10, rollbackVariants: variants.length }
}
