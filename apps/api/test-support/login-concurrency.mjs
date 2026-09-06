import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { URL, URLSearchParams } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { creation, opaque } from './login-fixtures.mjs'
import {
  assertCleared,
  counts,
  failure,
  fixture,
  proof,
  ready,
  row,
  started,
} from './login-database.mjs'
import {
  atExactTime,
  blockedBy,
  bounded,
  databaseNow,
  instrument,
  locked,
  settled,
  waitUntil,
} from './login-test-control.mjs'

const callbackQuery = (flow) =>
  new URLSearchParams({ state: flow.state, code: 'fixture-provider-code' })

async function assertCallbackClaim(source) {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  let calls = 0
  const subject = randomUUID()
  const f = await fixture(source, {
    verifyProvider: async () => {
      calls++
      entered.resolve()
      await release.promise
      return { provider: 'google', subject }
    },
  })
  const flow = await started(f.service)
  const pending = settled(f.service.callback('google', callbackQuery(flow), flow.cookie))
  try {
    await bounded(entered.promise)
    assert.equal((await row(source, flow.request.requestId)).status, 'processing')
    // 외부 provider가 멈춘 동안 별도 connection의 NOWAIT row lock이 즉시 성공한다.
    await source.transaction('READ COMMITTED', async (manager) => {
      await manager.query('SELECT id FROM auth_login_requests WHERE id=$1 FOR UPDATE NOWAIT', [
        flow.request.requestId,
      ])
    })
    await failure(
      () => f.service.callback('google', callbackQuery(flow), flow.cookie),
      'LOGIN_REQUEST_INVALID',
    )
    assert.equal(calls, 1)
  } finally {
    release.resolve()
  }
  const result = await pending
  assert.equal(result.error, undefined)
  assert(new URL(result.value.returnUrl).searchParams.get('code'))
  assert.equal((await row(source, flow.request.requestId)).status, 'exchange_ready')
}

async function assertSingleConsumer(source, kind) {
  const f = await fixture(source)
  let operation, id
  if (kind === 'exchange') {
    const flow = await ready(f.service)
    id = flow.request.requestId
    operation = () => f.service.exchange(flow.exchange)
  } else {
    const request = await f.service.create(creation(proof(opaque())))
    id = request.requestId
    operation = () => f.service.authorize(new URL(request.browserUrl).searchParams.get('ticket'))
  }
  const before = await counts(source)
  await locked(source, 'auth_login_requests', id, async ({ pid, unlock }) => {
    const pids = [],
      observed = Promise.withResolvers()
    const restore = instrument(source, {
      query: async ({ sql, query, run }) => {
        if (/auth_login_requests/.test(sql) && /FOR UPDATE/.test(sql)) {
          pids.push((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
          if (pids.length === 2) observed.resolve()
        }
        return run()
      },
    })
    const attempts = [settled(operation()), settled(operation())]
    try {
      await bounded(observed.promise)
      // 두 번째 waiter는 원 blocker 대신 앞 waiter의 tuple lock 뒤에 줄을 설 수 있다.
      for (const waiter of pids)
        await blockedBy(source, waiter, [pid, ...pids.filter((candidate) => candidate !== waiter)])
      await unlock()
      const results = await Promise.all(attempts)
      assert.equal(results.filter((result) => result.value).length, 1)
      assert.equal(
        results.filter(
          (result) =>
            result.error?.code ===
            (kind === 'exchange' ? 'LOGIN_EXCHANGE_INVALID' : 'LOGIN_REQUEST_INVALID'),
        ).length,
        1,
      )
    } finally {
      restore()
    }
  })
  const after = await counts(source)
  assert.equal(after.sessions - before.sessions, kind === 'exchange' ? 1 : 0)
  assert.equal(after.refresh - before.refresh, kind === 'exchange' ? 1 : 0)
}

async function assertFreshAfterWait(source, table) {
  const f = await fixture(source)
  let userId
  if (table === 'users') {
    const first = await ready(f.service)
    userId = (await f.service.exchange(first.exchange)).user.id
  }
  const flow = await ready(f.service)
  const before = await counts(source)
  const deadline = new Date((await databaseNow(source)).getTime() + 2000)
  await source.query('UPDATE auth_login_requests SET code_expires_at=$2 WHERE id=$1', [
    flow.request.requestId,
    deadline,
  ])
  await locked(source, table, userId ?? flow.request.requestId, async ({ pid, unlock }) => {
    const observed = Promise.withResolvers()
    const restore = instrument(source, {
      query: async ({ sql, query, run }) => {
        if (sql.includes(`"${table}"`) && sql.includes('FOR UPDATE')) {
          observed.resolve((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
        }
        return run()
      },
    })
    const pending = settled(f.service.exchange(flow.exchange))
    try {
      await blockedBy(source, await bounded(observed.promise), pid)
      await waitUntil(source, deadline)
      await unlock()
      assert.equal((await pending).error?.code, 'LOGIN_EXCHANGE_INVALID')
    } finally {
      restore()
    }
  })
  assert.deepEqual(await counts(source), before)
  assertCleared(await row(source, flow.request.requestId), 'failed')
}

async function assertExactExpiration(source) {
  const f = await fixture(source)
  const request = await f.service.create(creation(proof(opaque())))
  await atExactTime(source, (await row(source, request.requestId)).expires_at, () =>
    failure(
      () => f.service.authorize(new URL(request.browserUrl).searchParams.get('ticket')),
      'LOGIN_REQUEST_INVALID',
    ),
  )
  assertCleared(await row(source, request.requestId), 'failed')
  const browser = await started(f.service)
  await atExactTime(source, (await row(source, browser.request.requestId)).expires_at, () =>
    failure(
      () => f.service.callback('google', callbackQuery(browser), browser.cookie),
      'LOGIN_REQUEST_INVALID',
    ),
  )
  assertCleared(await row(source, browser.request.requestId), 'failed')
  for (const field of ['code_expires_at', 'expires_at']) {
    const flow = await ready(f.service)
    const before = await counts(source)
    const stored = await row(source, flow.request.requestId)
    await atExactTime(source, stored[field], () =>
      failure(() => f.service.exchange(flow.exchange), 'LOGIN_EXCHANGE_INVALID'),
    )
    assertCleared(await row(source, flow.request.requestId), 'failed')
    assert.deepEqual(await counts(source), before)
  }
}

async function assertCallbackDeadline(source) {
  const startedAt = Date.now(),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  let signal,
    calls = 0
  const f = await fixture(source, {
    verifyProvider: async (input) => {
      calls++
      signal = input.signal
      entered.resolve()
      await release.promise
      return { provider: 'google', subject: randomUUID() }
    },
  })
  const flow = await started(f.service)
  const result = settled(f.service.callback('google', callbackQuery(flow), flow.cookie))
  await bounded(entered.promise)
  const response = await result
  assert.equal(response.error?.code, 'AUTH_PROVIDER_ERROR')
  assert.equal(calls, 1)
  assert.equal(signal.aborted, true)
  assert(Date.now() - startedAt >= 9900)
  assert(Date.now() - startedAt < 13_000)
  assertCleared(await row(source, flow.request.requestId), 'failed')
  release.resolve()
  await delay(0)
  assertCleared(await row(source, flow.request.requestId), 'failed')
}

async function assertCallbackExpiryAndCompletionTime(source) {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  const f = await fixture(source, {
    verifyProvider: async () => {
      entered.resolve()
      await release.promise
      return { provider: 'google', subject: randomUUID() }
    },
  })
  const flow = await started(f.service)
  const pending = settled(f.service.callback('google', callbackQuery(flow), flow.cookie))
  await bounded(entered.promise)
  const time = await databaseNow(source)
  await source.query('UPDATE auth_login_requests SET created_at=$2, expires_at=$3 WHERE id=$1', [
    flow.request.requestId,
    new Date(time.getTime() - 600_000),
    time,
  ])
  release.resolve()
  assert.equal((await pending).error?.code, 'LOGIN_REQUEST_INVALID')
  assertCleared(await row(source, flow.request.requestId), 'failed')

  // Request 잔여 수명이 더 짧으면 code TTL을 거기서 자른다.
  const g = await fixture(source)
  const short = await started(g.service)
  const expiry = new Date((await databaseNow(source)).getTime() + 30_000)
  await source.query('UPDATE auth_login_requests SET created_at=$2, expires_at=$3 WHERE id=$1', [
    short.request.requestId,
    new Date(expiry.getTime() - 600_000),
    expiry,
  ])
  await g.service.callback('google', callbackQuery(short), short.cookie)
  assert.equal(
    (await row(source, short.request.requestId)).code_expires_at.getTime(),
    expiry.getTime(),
  )
}

async function assertCompletionLockTime(source) {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers()
  const f = await fixture(source, {
    verifyProvider: async () => {
      entered.resolve()
      await release.promise
      return { provider: 'google', subject: randomUUID() }
    },
  })
  const flow = await started(f.service)
  const pending = settled(f.service.callback('google', callbackQuery(flow), flow.cookie))
  await bounded(entered.promise)
  await locked(source, 'auth_login_requests', flow.request.requestId, async ({ pid, unlock }) => {
    const observed = Promise.withResolvers()
    const restore = instrument(source, {
      query: async ({ sql, query, run }) => {
        if (sql.includes('"auth_login_requests"') && sql.includes('FOR UPDATE'))
          observed.resolve((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
        return run()
      },
    })
    const earliest = Math.floor(Date.now() / 1000) * 1000
    release.resolve()
    try {
      await blockedBy(source, await bounded(observed.promise), pid)
      const latest = Math.floor(Date.now() / 1000) * 1000
      await waitUntil(source, new Date(latest + 2000))
      await unlock()
      assert.equal((await pending).error, undefined)
      const expiry = (await row(source, flow.request.requestId)).code_expires_at.getTime()
      assert(expiry >= earliest + 60_000)
      assert(expiry <= latest + 60_000)
    } finally {
      restore()
    }
  })
}

async function assertTwoIdentityExchanges(source) {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    secondInsert = Promise.withResolvers()
  let signer,
    signCalls = 0
  const f = await fixture(source, {
    issueAccessJwt: async (input) => {
      if (++signCalls === 1) {
        entered.resolve()
        await release.promise
      }
      return signer(input)
    },
  })
  signer = f.issueAccessJwt
  const [a, b] = await Promise.all([ready(f.service), ready(f.service)])
  const before = await counts(source)
  const pids = []
  const restore = instrument(source, {
    query: async ({ sql, query, run }) => {
      if (sql.startsWith('INSERT INTO "users"')) {
        pids.push((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
        if (pids.length === 2) secondInsert.resolve()
      }
      return run()
    },
  })
  const first = settled(f.service.exchange(a.exchange))
  let second
  try {
    await bounded(entered.promise)
    second = settled(f.service.exchange(b.exchange))
    await bounded(secondInsert.promise)
    await blockedBy(source, pids[1], pids[0])
    release.resolve()
    const results = await Promise.all([first, second])
    assert(results.every((result) => result.value))
    assert.equal(results[0].value.user.id, results[1].value.user.id)
    assert.equal(results.filter((result) => result.value.isNewUser).length, 1)
    assert.notEqual(results[0].value.refreshToken, results[1].value.refreshToken)
    assert.deepEqual(await counts(source), {
      users: before.users + 1,
      sessions: before.sessions + 2,
      refresh: before.refresh + 2,
    })
  } finally {
    release.resolve()
    await Promise.all([first, second])
    restore()
  }
}

export async function assertLoginConcurrency(source, mark) {
  const cases = [
    ['callback single claim and no provider-time lock', () => assertCallbackClaim(source)],
    ['concurrent ticket consumers', () => assertSingleConsumer(source, 'ticket')],
    ['concurrent exchange consumers', () => assertSingleConsumer(source, 'exchange')],
    [
      'OAuth row wait crosses code deadline',
      () => assertFreshAfterWait(source, 'auth_login_requests'),
    ],
    ['user row wait crosses code deadline', () => assertFreshAfterWait(source, 'users')],
    ['exact request and code expiration', () => assertExactExpiration(source)],
    [
      'callback request expiry and capped code TTL',
      () => assertCallbackExpiryAndCompletionTime(source),
    ],
    ['completion row wait cannot extend code TTL', () => assertCompletionLockTime(source)],
    [
      'distinct exchanges share one identity and independent sessions',
      () => assertTwoIdentityExchanges(source),
    ],
    [
      'single ten-second provider deadline and late result rejection',
      () => assertCallbackDeadline(source),
    ],
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  return cases.length
}
