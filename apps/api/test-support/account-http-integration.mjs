/* global fetch */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import {
  accountFixture,
  withAccountApp,
  accountRequest,
  rawAccountRequest,
  expectAccountError,
  snapshot
} from './account-http-fixtures.mjs'
import {
  instrument,
  bounded,
  settled,
  databaseNow,
  waitUntil,
  blockedBy
} from './login-test-control.mjs'
import { setDeadline, withLock } from './refresh-fixtures.mjs'

async function headPreservesActivity(source) {
  const f = await accountFixture(source)
  const before = await snapshot(source, f)
  await withAccountApp(f, async (base) => {
    const head = await fetch(`${base}/me`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${f.token.accessToken}` }
    })
    assert.equal(head.status, 400)
    assert.equal(head.headers.get('cache-control'), 'no-store')
    assert.equal(await head.text(), '')
    assert.deepEqual(await snapshot(source, f), before)

    // 같은 JWT의 GET 성공과 활동 갱신으로 HEAD 거절이 무효 자격 때문이 아님을 확인한다.
    const get = await accountRequest(base, f)
    assert.equal(get.status, 200)
    assert.deepEqual(await get.json(), {
      user: { id: before.user.id, nickname: before.user.nickname }
    })
    const afterGet = await snapshot(source, f)
    assert(afterGet.session.last_active_at > before.session.last_active_at)
  })
}

async function normal(source) {
  const f = await accountFixture(source)
  const before = await snapshot(source, f)
  await withAccountApp(f, async (base) => {
    const get = await accountRequest(base, f)
    assert.equal(get.status, 200)
    assert.equal(get.headers.get('cache-control'), 'no-store')
    assert.match(get.headers.get('content-type'), /^application\/json/)
    assert.deepEqual(await get.json(), {
      user: { id: before.user.id, nickname: before.user.nickname }
    })
    for (const nickname of ['  👩🏽‍🚀e\u0301  ', '중복', '중복']) {
      const patch = await accountRequest(base, f, 'PATCH', { nickname })
      assert.equal(patch.status, 200)
      assert.equal(patch.headers.get('cache-control'), 'no-store')
      assert.match(patch.headers.get('content-type'), /^application\/json/)
      assert.deepEqual(await patch.json(), {
        user: { id: before.user.id, nickname: nickname.trim() }
      })
    }
  })
  const after = await snapshot(source, f)
  assert.equal(after.user.nickname, '중복')
  assert(after.session.last_active_at > before.session.last_active_at)
  assert.equal(after.session.last_active_at.getMilliseconds(), 0)
  assert.deepEqual(after.tokens, before.tokens)
  const other = await accountFixture(source)
  await withAccountApp(other, async (base) => {
    assert.equal((await accountRequest(base, other, 'PATCH', { nickname: '중복' })).status, 200)
  })
}

async function initialRejections(source) {
  const f = await accountFixture(source)
  const before = await snapshot(source, f)
  await withAccountApp(f, async (base) => {
    for (const headers of [
      {},
      { authorization: 'Basic invalid' },
      { authorization: 'Bearer' },
      { authorization: `Bearer ${f.token.accessToken}, Bearer ${f.token.accessToken}` },
      { authorization: [`Bearer ${f.token.accessToken}`, `Bearer ${f.token.accessToken}`] }
    ]) {
      const response = await rawAccountRequest(base, {
        method: 'GET',
        path: `/me?accessToken=${f.token.accessToken}&userId=${f.initial.user.id}`,
        headers
      })
      assert.equal(response.status, 401)
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(JSON.parse(response.body).error.code, 'AUTHENTICATION_REQUIRED')
    }
    const queryOnlyPatch = await fetch(
      `${base}/me/nickname?accessToken=${f.token.accessToken}&userId=${f.initial.user.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: '새 이름' })
      }
    )
    await expectAccountError(queryOnlyPatch, 401, 'AUTHENTICATION_REQUIRED')
    for (const input of [
      null,
      [],
      {},
      { nickname: 'ok', userId: randomUUID() },
      { nickname: 'ok', token: f.token.accessToken }
    ]) {
      await expectAccountError(
        await accountRequest(base, f, 'PATCH', input),
        400,
        'INVALID_AUTH_REQUEST'
      )
    }
    for (const nickname of [
      null,
      1,
      '\ta',
      'a\n',
      '\ud800',
      '\udc00',
      '\u0085a',
      'a\u2028',
      '',
      'a'.repeat(21)
    ]) {
      await expectAccountError(
        await accountRequest(base, f, 'PATCH', { nickname }),
        400,
        'INVALID_NICKNAME'
      )
    }
  })
  assert.deepEqual(await snapshot(source, f), before)
}

async function inaccessible(source, kind, method) {
  const f = await accountFixture(source)
  const userId = f.initial.user.id
  const sessionId = f.initial.session.id
  const shouldDeleteUser = kind === 'user'
  if (shouldDeleteUser) {
    await source.query('DELETE FROM users WHERE id=$1', [userId])
  }
  const shouldDeleteSession = kind === 'session'
  if (shouldDeleteSession) {
    await source.query('DELETE FROM auth_sessions WHERE id=$1', [sessionId])
  }
  const shouldRevokeSession = kind === 'revoked'
  if (shouldRevokeSession) {
    await source.query(
      "UPDATE auth_sessions SET revoked_at=$2,revoked_reason='logout' WHERE id=$1",
      [sessionId, f.now]
    )
  }
  const shouldExpireSession = kind === 'idle'
  if (shouldExpireSession) {
    await setDeadline(source, sessionId, f.now)
  }
  const shouldChangeOwner = kind === 'owner'
  if (shouldChangeOwner) {
    const other = await accountFixture(source)
    await source.query('UPDATE auth_sessions SET user_id=$2 WHERE id=$1', [
      sessionId,
      other.initial.user.id
    ])
  }
  const before = await snapshot(source, f)
  await withAccountApp(f, async (base) => {
    await expectAccountError(await accountRequest(base, f, method), 401, 'AUTHENTICATION_REQUIRED')
  })
  assert.deepEqual(await snapshot(source, f), before)
}

async function boundary(source, phase, boundaryKind, method) {
  const f = await accountFixture(source)
  const before = await snapshot(source, f)
  const isIdleBoundary = boundaryKind === 'idle'
  const isAdmissionPhase = phase === 'admission'
  const checkedAt = isIdleBoundary
    ? new Date(f.now.getTime() + (isAdmissionPhase ? 0 : 2_592_000_000))
    : new Date(f.token.expiresAt * 1000)
  const shouldSetInitialDeadline = isIdleBoundary && isAdmissionPhase
  if (shouldSetInitialDeadline) {
    await setDeadline(source, f.initial.session.id, checkedAt)
  }
  const admittedBefore = await snapshot(source, f)
  let clocks = 0
  const restore = instrument(source, {
    query: async ({ sql, run }) => {
      const result = await run()
      const isClock = sql.includes('clock_timestamp()')
      if (!isClock) {
        return result
      }
      clocks++
      const atAdmission = phase === 'admission'
      const isFunctionClock = !atAdmission && clocks === 2
      const isTarget = atAdmission || isFunctionClock
      const time = isTarget ? checkedAt : f.now
      return [{ now: time }]
    }
  })
  try {
    await withAccountApp(f, async (base) => {
      const response = await accountRequest(base, f, method)
      const shouldReject = isAdmissionPhase || isIdleBoundary
      if (shouldReject) {
        await expectAccountError(response, 401, 'AUTHENTICATION_REQUIRED')
      } else {
        assert.equal(response.status, 200)
      }
    })
  } finally {
    restore()
  }
  assert(clocks >= 1)
  const after = await snapshot(source, f)
  const isAdmission = phase === 'admission'
  if (isAdmission) {
    assert.deepEqual(after, admittedBefore)
  }
  if (!isAdmission) {
    assert(after.session.last_active_at > before.session.last_active_at)
  }
}

async function realLockExpiry(source, table, method, kind) {
  const f = await accountFixture(source)
  const deadline = new Date((await databaseNow(source)).getTime() + 2000)
  const isIdleBoundary = kind === 'idle'
  if (isIdleBoundary) {
    await setDeadline(source, f.initial.session.id, deadline)
  } else {
    f.token = await f.deps.issueAccessJwt({
      userId: f.initial.user.id,
      sessionId: f.initial.session.id,
      issuedAt: f.now.getTime() / 1000,
      idleDeadline: deadline.getTime() / 1000
    })
  }
  const before = await snapshot(source, f)
  await withAccountApp(f, async (base) => {
    await withLock(source, table, f, async ({ runner, pid, unlock }) => {
      const started = Promise.withResolvers()
      const restore = instrument(source, {
        query: async ({ sql, query, run }) => {
          const result = await run()
          const isStart = sql === 'START TRANSACTION'
          if (isStart) {
            started.resolve((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
          }
          return result
        }
      })
      let pending
      try {
        pending = settled(accountRequest(base, f, method))
        const waiter = await bounded(started.promise)
        await blockedBy(source, waiter, pid)
        await waitUntil(source, deadline)
        await unlock()
        const response = await bounded(pending)
        assert.equal(response.error, undefined)
        await expectAccountError(response.value, 401, 'AUTHENTICATION_REQUIRED')
      } finally {
        restore()
        if (runner.isTransactionActive) {
          await unlock()
        }
        const hasPendingRequest = pending != null
        if (hasPendingRequest) {
          await pending
        }
      }
    })
  })
  assert.deepEqual(await snapshot(source, f), before)
}

async function removalBeforeAdmission(source, kind, method) {
  const f = await accountFixture(source)
  const before = await snapshot(source, f)
  await withAccountApp(f, async (base) => {
    const held = Promise.withResolvers()
    const release = Promise.withResolvers()
    const waiterStarted = Promise.withResolvers()
    const pids = []
    let commits = 0
    const restore = instrument(source, {
      query: async ({ sql, query, run }) => {
        const result = await run()
        const isStart = sql === 'START TRANSACTION'
        if (isStart) {
          pids.push((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
          const hasWaiter = pids.length === 2
          if (hasWaiter) {
            waiterStarted.resolve()
          }
        }
        return result
      },
      commit: async (_runner, commit) => {
        commits++
        const isRemoval = commits === 1
        if (isRemoval) {
          held.resolve()
          await release.promise
        }
        await commit()
      }
    })
    let removal
    let account
    try {
      const isLogout = kind === 'logout'
      removal = settled(
        isLogout
          ? fetch(`${base}/auth/logout`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ refreshToken: f.initial.refreshToken })
            })
          : source.transaction('READ COMMITTED', async (manager) => {
              await manager.query('DELETE FROM users WHERE id=$1', [f.initial.user.id])
            })
      )
      await bounded(held.promise)
      account = settled(accountRequest(base, f, method))
      await bounded(waiterStarted.promise)
      await blockedBy(source, pids[1], pids[0])
      release.resolve()
      const removed = await bounded(removal)
      assert.equal(removed.error, undefined)
      if (isLogout) {
        assert.equal(removed.value.status, 204)
      }
      const result = await bounded(account)
      assert.equal(result.error, undefined)
      await expectAccountError(result.value, 401, 'AUTHENTICATION_REQUIRED')
    } finally {
      release.resolve()
      await Promise.all([removal, account])
      restore()
    }
  })
  const after = await snapshot(source, f)
  const isLogout = kind === 'logout'
  if (isLogout) {
    assert.equal(after.session.last_active_at.getTime(), before.session.last_active_at.getTime())
    assert.equal(after.user.nickname, before.user.nickname)
  } else {
    assert.deepEqual(after, { user: undefined, session: undefined, tokens: [] })
  }
}

async function betweenPhases(source, kind, method) {
  const f = await accountFixture(source)
  const before = await snapshot(source, f)
  const admissionApplied = Promise.withResolvers()
  const continueFunction = Promise.withResolvers()
  let commits = 0
  const restore = instrument(source, {
    commit: async (_runner, commit) => {
      commits++
      const isAdmission = commits === 1
      await commit()
      if (isAdmission) {
        admissionApplied.resolve()
        await continueFunction.promise
      }
    }
  })
  try {
    await withAccountApp(f, async (base) => {
      let pending
      try {
        pending = settled(accountRequest(base, f, method))
        await bounded(admissionApplied.promise)
        const admitted = await snapshot(source, f)
        assert(admitted.session.last_active_at > before.session.last_active_at)
        const shouldLogout = kind === 'logout'
        if (shouldLogout) {
          const response = await fetch(`${base}/auth/logout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refreshToken: f.initial.refreshToken })
          })
          assert.equal(response.status, 204)
        } else {
          await source.query('DELETE FROM users WHERE id=$1', [f.initial.user.id])
        }
        continueFunction.resolve()
        const result = await bounded(pending)
        assert.equal(result.error, undefined)
        await expectAccountError(result.value, 401, 'AUTHENTICATION_REQUIRED')
        const after = await snapshot(source, f)
        const isLogout = kind === 'logout'
        if (isLogout) {
          assert.equal(after.user.nickname, before.user.nickname)
          assert.equal(
            after.session.last_active_at.getTime(),
            admitted.session.last_active_at.getTime()
          )
          assert.equal(after.session.revoked_reason, 'logout')
        } else {
          assert.deepEqual(after, { user: undefined, session: undefined, tokens: [] })
        }
      } finally {
        continueFunction.resolve()
        const hasPendingRequest = pending != null
        if (hasPendingRequest) {
          await pending
        }
      }
    })
  } finally {
    continueFunction.resolve()
    restore()
  }
}

async function databaseFailure(source, phase, applied, method) {
  const f = await accountFixture(source)
  const before = await snapshot(source, f)
  let commits = 0
  let stdout = ''
  let stderr = ''
  const writeOut = process.stdout.write
  const writeErr = process.stderr.write
  process.stdout.write = function (chunk) {
    stdout += String(chunk)
    return true
  }
  process.stderr.write = function (chunk) {
    stderr += String(chunk)
    return true
  }
  const restore = instrument(source, {
    query: async ({ sql, run }) => {
      const isNicknameWrite = sql.startsWith('UPDATE "users"')
      const isWriteFailurePhase = phase === 'write'
      const failWrite = isWriteFailurePhase && isNicknameWrite
      const isUserRead = sql.includes('FROM "users"')
      const isInitialReadPhase = phase === 'read'
      const isInitialReadFailure = isInitialReadPhase && isUserRead
      const isFunctionReadPhase = phase === 'function-read'
      const hasCommittedAdmission = isFunctionReadPhase && commits === 1
      const isFunctionReadFailure = hasCommittedAdmission && isUserRead
      const failRead = isInitialReadFailure || isFunctionReadFailure
      const shouldFailQuery = failWrite || failRead
      if (shouldFailQuery) {
        throw new Error('private SQL nickname identity credential canary')
      }
      return run()
    },
    commit: async (runner, commit) => {
      commits++
      const isAdmissionFailure = phase === 'admission'
      const target = isAdmissionFailure ? 1 : 2
      const isCommitFailurePhase = ['admission', 'function'].includes(phase)
      const failCommit = isCommitFailurePhase && commits === target
      if (!failCommit) {
        return commit()
      }
      if (applied) {
        await commit()
      } else {
        await runner.rollbackTransaction()
      }
      throw new Error('private SQL nickname identity credential canary')
    }
  })
  try {
    await withAccountApp(f, async (base) => {
      const body = await expectAccountError(
        await accountRequest(base, f, method),
        503,
        'AUTH_UNAVAILABLE'
      )
      assert.equal(
        body.error.message,
        '현재 계정 기능을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'
      )
    })
  } finally {
    restore()
    process.stdout.write = writeOut
    process.stderr.write = writeErr
  }
  for (const value of [
    f.token.accessToken,
    f.initial.refreshToken,
    f.identity.subject,
    f.initial.user.id,
    '변경 이름',
    'private SQL'
  ]) {
    assert.equal(stdout.includes(value), false)
    assert.equal(stderr.includes(value), false)
  }
  const after = await snapshot(source, f)
  const isInitialReadFailure = phase === 'read'
  const isAdmissionFailure = !isInitialReadFailure && phase === 'admission'
  const hasUncommittedAdmission = isAdmissionFailure && !applied
  const noActivity = isInitialReadFailure || hasUncommittedAdmission
  if (noActivity) {
    assert.deepEqual(after, before)
  } else {
    assert(after.session.last_active_at > before.session.last_active_at)
  }
  const isFunctionCommit = phase === 'function'
  const isAppliedFunctionCommit = isFunctionCommit && applied
  const nicknameApplied = isAppliedFunctionCommit && method === 'PATCH'
  assert.equal(after.user.nickname, nicknameApplied ? '변경 이름' : before.user.nickname)
}

export async function assertAccountHttpIntegration(source, mark) {
  const cases = [
    [
      'valid JWT HEAD refuses without activity and GET still records activity',
      () => headPreservesActivity(source)
    ],
    ['profile shape, Unicode preservation, duplicate nickname and activity', () => normal(source)],
    [
      'strict bearer, shape and raw nickname refusals leave activity unchanged',
      () => initialRejections(source)
    ],
    ...['GET', 'PATCH'].flatMap((method) => [
      ...['user', 'session', 'owner', 'revoked', 'idle'].map((kind) => [
        `${method} inaccessible ${kind}`,
        () => inaccessible(source, kind, method)
      ]),
      ...['jwt', 'idle'].map((kind) => [
        `${method} exact admission ${kind} expiry`,
        () => boundary(source, 'admission', kind, method)
      ]),
      [
        `${method} function elapsed JWT preserves admitted request`,
        () => boundary(source, 'function', 'jwt', method)
      ],
      [
        `${method} function exact idle rejects while preserving activity`,
        () => boundary(source, 'function', 'idle', method)
      ],
      ...['users', 'auth_sessions'].flatMap((table) =>
        ['jwt', 'idle'].map((kind) => [
          `${method} real ${table} lock crosses ${kind} deadline`,
          () => realLockExpiry(source, table, method, kind)
        ])
      ),
      ...['logout', 'delete'].map((kind) => [
        `${method} committed activity then ${kind}`,
        () => betweenPhases(source, kind, method)
      ]),
      ...['logout', 'delete'].map((kind) => [
        `${method} ${kind} commit blocks admission`,
        () => removalBeforeAdmission(source, kind, method)
      ]),
      [`${method} database read failure`, () => databaseFailure(source, 'read', false, method)],
      [
        `${method} function read failure preserves admitted activity`,
        () => databaseFailure(source, 'function-read', false, method)
      ],
      ...['admission', 'function'].flatMap((phase) =>
        [false, true].map((applied) => [
          `${method} ${phase} commit acknowledgement unknown applied=${applied}`,
          () => databaseFailure(source, phase, applied, method)
        ])
      )
    ]),
    [
      'nickname write failure preserves committed activity',
      () => databaseFailure(source, 'write', false, 'PATCH')
    ]
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  return cases.length
}
