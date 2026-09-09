import assert from 'node:assert/strict'
import {
  blockedBy,
  bounded,
  databaseNow,
  instrument,
  settled,
  waitUntil
} from './login-test-control.mjs'
import {
  digest,
  fixture,
  rejected,
  revoke,
  setDeadline,
  stored,
  withLock
} from './refresh-fixtures.mjs'

async function observeWaitingRefresh({ source, kind, fixture: f }, controller) {
  await withLock(source, kind, f, async (lock) => {
    const observed = Promise.withResolvers()
    const restore = instrument(source, {
      query: async ({ sql, query, run }) => {
        const isTargetTableQuery = sql.includes(`"${kind}"`)
        const hasUpdateLock = isTargetTableQuery && sql.includes('FOR UPDATE')
        const isTargetTableLock = isTargetTableQuery && hasUpdateLock
        if (isTargetTableLock) {
          observed.resolve((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
        }
        return run()
      }
    })
    const pending = settled(f.rotate(f.initial.refreshToken))
    try {
      await blockedBy(source, await bounded(observed.promise), lock.pid)
      await controller(lock, pending)
    } finally {
      if (lock.runner.isTransactionActive) {
        await lock.runner.rollbackTransaction()
      }
      await pending
      restore()
    }
  })
}

async function concurrentR0(source) {
  const f = await fixture(source)
  await withLock(source, 'users', f, async ({ pid, unlock }) => {
    const pids = []
    const observed = Promise.withResolvers()
    const restore = instrument(source, {
      query: async ({ sql, query, run }) => {
        const isUserQuery = sql.includes('"users"')
        const hasUpdateLock = isUserQuery && sql.includes('FOR UPDATE')
        const isUserLock = isUserQuery && hasUpdateLock
        if (isUserLock) {
          pids.push((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
          const haveBothRefreshesEntered = pids.length === 2
          if (haveBothRefreshesEntered) {
            observed.resolve()
          }
        }
        return run()
      }
    })
    const pending = [
      settled(f.rotate(f.initial.refreshToken)),
      settled(f.rotate(f.initial.refreshToken))
    ]
    try {
      await bounded(observed.promise)
      for (const waiter of pids) {
        await blockedBy(source, waiter, [pid, ...pids.filter((candidate) => candidate !== waiter)])
      }
      await unlock()
      const results = await Promise.all(pending)
      assert.equal(
        results.filter((result) => {
          const hasSuccessfulResult = result.value != null
          return hasSuccessfulResult
        }).length,
        1
      )
      assert.equal(
        results.filter((result) => {
          const isAuthenticationRequired = result.error?.code === 'AUTHENTICATION_REQUIRED'
          return isAuthenticationRequired
        }).length,
        1
      )
      const next = results.find((result) => {
        const hasSuccessfulResult = result.value != null
        return hasSuccessfulResult
      }).value.refreshToken
      await rejected(() => f.rotate(next))
      const final = await stored(source, f.initial.session.id)
      assert.equal(final.session.revoked_reason, 'refresh_reuse')
      assert.equal(final.tokens.length, 2)
    } finally {
      restore()
    }
  })
}

async function r2BeforeReuse(source) {
  const f = await fixture(source)
  const signer = f.deps.issueAccessJwt
  const signing = Promise.withResolvers()
  const releaseSigning = Promise.withResolvers()
  let signCalls = 0
  f.deps.issueAccessJwt = async (input) => {
    const isFirstSigningCall = ++signCalls === 1
    if (isFirstSigningCall) {
      signing.resolve()
      await releaseSigning.promise
    }
    return signer(input)
  }
  const first = settled(f.rotate(f.initial.refreshToken))
  await bounded(signing.promise)
  const replayReady = Promise.withResolvers()
  const releaseReplay = Promise.withResolvers()
  let paused = false
  const restore = instrument(source, {
    query: async ({ sql, run }) => {
      const canPauseReplay = !paused
      const isUserQuery = canPauseReplay && sql.includes('"users"')
      const hasUpdateLock = isUserQuery && sql.includes('FOR UPDATE')
      const shouldPauseReplay = canPauseReplay && isUserQuery && hasUpdateLock
      if (shouldPauseReplay) {
        paused = true
        replayReady.resolve()
        await releaseReplay.promise
      }
      return run()
    }
  })
  const replay = settled(f.rotate(f.initial.refreshToken))
  try {
    // B가 R0 hint를 읽은 뒤 잠금 실행 직전에 멈춘 동안 A와 R1 사용자가 먼저 commit한다.
    await bounded(replayReady.promise)
    releaseSigning.resolve()
    const firstResult = await first
    assert.equal(firstResult.error, undefined)
    const r1 = firstResult.value.refreshToken
    const second = await f.rotate(r1)
    const r2 = second.refreshToken
    assert.equal((await stored(source, f.initial.session.id)).session.revoked_at, null)
    releaseReplay.resolve()
    assert.equal((await replay).error?.code, 'AUTHENTICATION_REQUIRED')
    await rejected(() => f.rotate(r1))
    await rejected(() => f.rotate(r2))
    const final = await stored(source, f.initial.session.id)
    assert.equal(final.session.revoked_reason, 'refresh_reuse')
    assert.equal(final.tokens.length, 3)
    assert.equal(final.tokens.filter((token) => token.consumed_at === null).length, 1)
  } finally {
    releaseSigning.resolve()
    releaseReplay.resolve()
    await Promise.all([first, replay])
    restore()
  }
}

async function expiresWhileWaiting(source, kind) {
  const f = await fixture(source)
  const deadline = new Date((await databaseNow(source)).getTime() + 2000)
  await setDeadline(source, f.initial.session.id, deadline)
  const before = await stored(source, f.initial.session.id)
  await observeWaitingRefresh(
    {
      source,
      kind,
      fixture: f
    },
    async ({ unlock }, pending) => {
      await waitUntil(source, deadline)
      await unlock()
      assert.equal((await pending).error?.code, 'AUTHENTICATION_REQUIRED')
    }
  )
  assert.deepEqual(await stored(source, f.initial.session.id), before)
}

async function logoutFirst(source) {
  const f = await fixture(source)
  const before = await stored(source, f.initial.session.id)
  await observeWaitingRefresh(
    {
      source,
      kind: 'auth_sessions',
      fixture: f
    },
    async ({ runner, unlock }, pending) => {
      await revoke(runner, f.initial.session.id)
      await unlock()
      assert.equal((await pending).error?.code, 'AUTHENTICATION_REQUIRED')
    }
  )
  const after = await stored(source, f.initial.session.id)
  assert.equal(after.session.revoked_reason, 'logout')
  assert.deepEqual(after.tokens, before.tokens)
  await rejected(() => f.rotate(f.initial.refreshToken))
  assert.deepEqual(await stored(source, f.initial.session.id), after)
}

async function refreshBeforeLogoutWithLateResult(source) {
  const f = await fixture(source)
  const committed = Promise.withResolvers()
  const releaseResult = Promise.withResolvers()
  let held = false
  const restore = instrument(source, {
    commit: async (_runner, commit) => {
      await commit()
      if (!held) {
        held = true
        committed.resolve()
        await releaseResult.promise
      }
    }
  })
  const pending = settled(f.rotate(f.initial.refreshToken))
  try {
    await bounded(committed.promise)
    await source.transaction('READ COMMITTED', async (manager) => {
      await manager.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.initial.user.id])
      await manager.query('SELECT id FROM auth_sessions WHERE id=$1 FOR UPDATE', [
        f.initial.session.id
      ])
      await revoke(manager, f.initial.session.id)
    })
    releaseResult.resolve()
    const response = await pending
    assert.equal(response.error, undefined)
    await rejected(() => f.rotate(response.value.refreshToken))
    assert.equal((await stored(source, f.initial.session.id)).session.revoked_reason, 'logout')
  } finally {
    releaseResult.resolve()
    await pending
    restore()
  }
}

async function deletedAfterHint(source, kind) {
  const f = await fixture(source)
  const unrelated = await fixture(source)
  const preserved = await stored(source, unrelated.initial.session.id)
  await observeWaitingRefresh(
    {
      source,
      kind,
      fixture: f
    },
    async ({ runner, unlock }, pending) => {
      const isUserDeletion = kind === 'users'
      if (isUserDeletion) {
        await runner.query('DELETE FROM users WHERE id=$1', [f.initial.user.id])
      } else {
        await runner.query('DELETE FROM auth_sessions WHERE id=$1', [f.initial.session.id])
      }
      await unlock()
      assert.equal((await pending).error?.code, 'AUTHENTICATION_REQUIRED')
    }
  )
  assert.deepEqual(await stored(source, f.initial.session.id), { session: undefined, tokens: [] })
  await rejected(() => f.rotate(f.initial.refreshToken))
  assert.deepEqual(await stored(source, unrelated.initial.session.id), preserved)
  const isUserDeletion = kind === 'users'
  if (isUserDeletion) {
    assert.equal(
      (await source.query('SELECT id FROM users WHERE id=$1', [f.initial.user.id])).length,
      0
    )
  }
}

async function staleOwnership(source, kind) {
  const f = await fixture(source)
  await f.rotate(f.initial.refreshToken)
  const other = await fixture(source)
  const preserved = await stored(source, other.initial.session.id)
  await observeWaitingRefresh(
    {
      source,
      kind,
      fixture: f
    },
    async ({ runner, unlock }, pending) => {
      const isSessionOwnershipChange = kind === 'auth_sessions'
      if (isSessionOwnershipChange) {
        await runner.query('UPDATE auth_sessions SET user_id=$2 WHERE id=$1', [
          f.initial.session.id,
          other.initial.user.id
        ])
      } else {
        await runner.query('UPDATE auth_refresh_tokens SET session_id=$2 WHERE token_hash=$1', [
          digest(f.initial.refreshToken),
          other.initial.session.id
        ])
      }
      await unlock()
      assert.equal((await pending).error?.code, 'AUTHENTICATION_REQUIRED')
    }
  )
  assert.equal((await stored(source, f.initial.session.id)).session.revoked_at, null)
  const after = await stored(source, other.initial.session.id)
  assert.deepEqual(after.session, preserved.session)
  // 이 test가 직접 옮긴 consumed row 외에는 다른 session의 이력 변화가 없다.
  assert.deepEqual(
    after.tokens.filter((token) => !token.token_hash.equals(digest(f.initial.refreshToken))),
    preserved.tokens
  )
}

async function activityBeforeWait(source) {
  const f = await fixture(source)
  const deadline = new Date((await databaseNow(source)).getTime() + 2000)
  await setDeadline(source, f.initial.session.id, deadline)
  let activityAt
  await observeWaitingRefresh(
    {
      source,
      kind: 'auth_sessions',
      fixture: f
    },
    async ({ runner, unlock }, pending) => {
      activityAt = await databaseNow(runner)
      const isActivityBeforeDeadline = activityAt < deadline
      assert(isActivityBeforeDeadline)
      await runner.query('UPDATE auth_sessions SET last_active_at=$2 WHERE id=$1', [
        f.initial.session.id,
        activityAt
      ])
      await waitUntil(source, deadline)
      await unlock()
      assert.equal((await pending).error, undefined)
    }
  )
  assert.equal(
    (await stored(source, f.initial.session.id)).session.last_active_at.getTime(),
    activityAt.getTime()
  )
}

export async function assertRefreshConcurrency(source, mark) {
  const cases = [
    ['actual concurrent R0 consumers', () => concurrentR0(source)],
    ['R1 and R2 revoked after delayed concurrent R0 reuse', () => r2BeforeReuse(source)],
    ...['users', 'auth_sessions', 'auth_refresh_tokens'].map((kind) => [
      `${kind} lock wait crosses idle deadline`,
      () => expiresWhileWaiting(source, kind)
    ]),
    ['logout before refresh', () => logoutFirst(source)],
    [
      'refresh commits before logout with late result',
      () => refreshBeforeLogoutWithLateResult(source)
    ],
    ...['users', 'auth_sessions'].map((kind) => [
      `${kind} deletion after hint`,
      () => deletedAfterHint(source, kind)
    ]),
    ...['auth_sessions', 'auth_refresh_tokens'].map((kind) => [
      `${kind} ownership changed after hint`,
      () => staleOwnership(source, kind)
    ]),
    ['activity commits updated deadline after refresh waits', () => activityBeforeWait(source)]
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  return cases.length
}
