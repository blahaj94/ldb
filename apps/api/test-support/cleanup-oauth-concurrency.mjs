import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { URL, URLSearchParams } from 'node:url'
import { counts, failure, fixture, ready, row, started } from './login-database.mjs'
import {
  blockedBy,
  bounded,
  databaseNow,
  instrument,
  settled,
  waitUntil
} from './login-test-control.mjs'
import { cleanupWaitingOn, withCleanupDeletionHeld } from './cleanup-database-control.mjs'

async function setRequestDeadline(source, id, deadline) {
  const updateRequestDeadlineSql = `UPDATE auth_login_requests
    SET created_at=$2::timestamptz-interval '600 seconds', expires_at=$2,
        code_expires_at=CASE WHEN code_expires_at IS NULL THEN NULL ELSE $2 END
    WHERE id=$1`
  await source.query(updateRequestDeadlineSql, [id, deadline])
}

function callback(f, flow) {
  return f.service.callback(
    'google',
    new URLSearchParams({ state: flow.state, code: 'fixture-provider-code' }),
    flow.cookie
  )
}

async function providerInFlight(source, cleanup, expired) {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let providerCalls = 0
  const subject = randomUUID()
  const f = await fixture(source, {
    verifyProvider: async () => {
      providerCalls++
      entered.resolve()
      await release.promise
      return { provider: 'google', subject }
    }
  })
  const flow = await started(f.service)
  const baseline = await counts(source)
  const pending = settled(callback(f, flow))
  try {
    await bounded(entered.promise)
    assert.equal((await row(source, flow.request.requestId)).status, 'processing')
    if (expired) {
      await setRequestDeadline(source, flow.request.requestId, await databaseNow(source))
    }
    await cleanup(source)
    const remaining = await row(source, flow.request.requestId)
    if (expired) {
      assert.equal(remaining, undefined)
    } else {
      assert.equal(remaining.status, 'processing')
    }
    release.resolve()
    const result = await pending
    assert.equal(result.error?.code, expired ? 'LOGIN_REQUEST_INVALID' : undefined)
    const final = await row(source, flow.request.requestId)
    if (expired) {
      assert.equal(final, undefined)
    } else {
      assert.equal(final.status, 'exchange_ready')
    }
    assert.equal(providerCalls, 1)
    assert.deepEqual(await counts(source), baseline)
  } finally {
    release.resolve()
    await pending
  }
}

async function cleanupBeforeCallbackCompletion(source, cleanup) {
  const providerEntered = Promise.withResolvers()
  const releaseProvider = Promise.withResolvers()
  const f = await fixture(source, {
    verifyProvider: async () => {
      providerEntered.resolve()
      await releaseProvider.promise
      return { provider: 'google', subject: randomUUID() }
    }
  })
  const flow = await started(f.service)
  const baseline = await counts(source)
  const pending = settled(callback(f, flow))
  try {
    await bounded(providerEntered.promise)
    await setRequestDeadline(source, flow.request.requestId, await databaseNow(source))
    await withCleanupDeletionHeld({
      source,
      cleanup,
      table: 'auth_login_requests',
      id: flow.request.requestId,
      operation: async ({ pid, waiter, release }) => {
        releaseProvider.resolve()
        await blockedBy(source, await bounded(waiter), pid)
        release()
        assert.equal((await pending).error?.code, 'LOGIN_REQUEST_INVALID')
      }
    })
  } finally {
    releaseProvider.resolve()
    await pending
  }
  assert.equal(await row(source, flow.request.requestId), undefined)
  assert.deepEqual(await counts(source), baseline)
}

async function callbackCompletionBeforeCleanup(source, cleanup) {
  const f = await fixture(source)
  const flow = await started(f.service)
  const baseline = await counts(source)
  const deadline = new Date((await databaseNow(source)).getTime() + 1000)
  await setRequestDeadline(source, flow.request.requestId, deadline)
  const committing = Promise.withResolvers()
  const release = Promise.withResolvers()
  let commits = 0
  const restore = instrument(source, {
    commit: async (runner, commit) => {
      commits++
      const isCompletion = commits === 2
      if (isCompletion) {
        committing.resolve((await runner.query('SELECT pg_backend_pid() AS pid'))[0].pid)
        await release.promise
      }
      await commit()
    }
  })
  const pending = settled(callback(f, flow))
  try {
    const pid = await bounded(committing.promise)
    await waitUntil(source, deadline)
    await cleanupWaitingOn({
      source,
      cleanup,
      table: 'auth_login_requests',
      id: flow.request.requestId,
      blocker: pid,
      unlock: () => release.resolve()
    })
    const result = await pending
    assert.equal(result.error, undefined)
    const code = new URL(result.value.returnUrl).searchParams.get('code')
    await failure(
      () =>
        f.service.exchange({
          requestId: flow.request.requestId,
          clientId: 'desktop',
          code,
          codeVerifier: flow.verifier
        }),
      'LOGIN_EXCHANGE_INVALID'
    )
  } finally {
    release.resolve()
    await pending
    restore()
  }
  assert.equal(await row(source, flow.request.requestId), undefined)
  assert.deepEqual(await counts(source), baseline)
}

async function cleanupBeforeExchange(source, cleanup) {
  const f = await fixture(source)
  const flow = await ready(f.service)
  const baseline = await counts(source)
  await setRequestDeadline(source, flow.request.requestId, await databaseNow(source))
  await withCleanupDeletionHeld({
    source,
    cleanup,
    table: 'auth_login_requests',
    id: flow.request.requestId,
    operation: async ({ pid, waiter, release }) => {
      const pending = settled(f.service.exchange(flow.exchange))
      try {
        await blockedBy(source, await bounded(waiter), pid)
        release()
        assert.equal((await pending).error?.code, 'LOGIN_EXCHANGE_INVALID')
      } finally {
        release()
        await pending
      }
    }
  })
  assert.equal(await row(source, flow.request.requestId), undefined)
  assert.deepEqual(await counts(source), baseline)
}

async function exchangeBeforeCleanup(source, cleanup) {
  const f = await fixture(source)
  const flow = await ready(f.service)
  const baseline = await counts(source)
  const deadline = new Date((await databaseNow(source)).getTime() + 1000)
  await setRequestDeadline(source, flow.request.requestId, deadline)
  const committing = Promise.withResolvers()
  const release = Promise.withResolvers()
  let held = false
  const restore = instrument(source, {
    commit: async (runner, commit) => {
      if (!held) {
        held = true
        committing.resolve((await runner.query('SELECT pg_backend_pid() AS pid'))[0].pid)
        await release.promise
      }
      await commit()
    }
  })
  const pending = settled(f.service.exchange(flow.exchange))
  try {
    const pid = await bounded(committing.promise)
    await waitUntil(source, deadline)
    await cleanupWaitingOn({
      source,
      cleanup,
      table: 'auth_login_requests',
      id: flow.request.requestId,
      blocker: pid,
      unlock: () => release.resolve()
    })
    const result = await pending
    assert.equal(result.error, undefined)
    assert.equal(await row(source, flow.request.requestId), undefined)
    assert.deepEqual(await counts(source), {
      users: baseline.users + 1,
      sessions: baseline.sessions + 1,
      refresh: baseline.refresh + 1
    })
    const principal = await f.verifyJwt(
      result.value.accessToken,
      (await databaseNow(source)).getTime() / 1000
    )
    assert.equal(
      (
        await source.query('SELECT id FROM auth_sessions WHERE id=$1 AND user_id=$2', [
          principal.sessionId,
          result.value.user.id
        ])
      ).length,
      1
    )
    assert.deepEqual(await cleanup(source), { sessionsDeleted: 0, loginRequestsDeleted: 0 })
    assert.equal(
      (await source.query('SELECT id FROM auth_sessions WHERE id=$1', [principal.sessionId]))
        .length,
      1
    )
  } finally {
    release.resolve()
    await pending
    restore()
  }
}

export async function assertCleanupOAuthConcurrency(source, cleanup, mark) {
  const cases = [
    [
      'valid provider HTTP processing survives cleanup',
      () => providerInFlight(source, cleanup, false)
    ],
    [
      'expired provider HTTP processing cannot be restored',
      () => providerInFlight(source, cleanup, true)
    ],
    [
      'callback completion waits on cleanup deletion',
      () => cleanupBeforeCallbackCompletion(source, cleanup)
    ],
    [
      'cleanup waits on callback completion and rereads expired row',
      () => callbackCompletionBeforeCleanup(source, cleanup)
    ],
    [
      'exchange waits on cleanup deletion without account/session creation',
      () => cleanupBeforeExchange(source, cleanup)
    ],
    [
      'cleanup waits on successful exchange and preserves issued account/session',
      () => exchangeBeforeCleanup(source, cleanup)
    ]
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  return cases.length
}
