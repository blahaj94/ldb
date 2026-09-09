import assert from 'node:assert/strict'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { DataSource } from 'typeorm'
import {
  searchFixture,
  withSearchApp,
  searchRequest,
  expectSearchError,
  snapshot,
  observeSearchRunners,
  waitFor
} from './character-search-fixtures.mjs'

async function databaseFailure(source, phase, applied) {
  const f = await searchFixture(source)
  const before = await snapshot(source, f)
  let fail = true
  const createQueryRunner = observeSearchRunners({
    query: async ({ sql, run }) => {
      const isRead = sql.includes('auth_sessions') && sql.includes('FOR UPDATE')
      const isWrite = sql.startsWith('UPDATE "auth_sessions"')
      const shouldFailRead = phase === 'read' && isRead
      const shouldFailWrite = phase === 'write' && isWrite
      const shouldFail = fail && (shouldFailRead || shouldFailWrite)
      if (shouldFail) {
        throw new Error('synthetic private SQL credential canary')
      }
      return run()
    },
    commit: async (runner, commit) => {
      const shouldFail = fail && phase === 'commit'
      if (!shouldFail) {
        return commit()
      }
      if (applied) {
        await commit()
      } else {
        await runner.rollbackTransaction()
      }
      throw new Error('synthetic private commit credential canary')
    }
  })
  const output = { stdout: '', stderr: '' }
  const writeOut = process.stdout.write
  const writeErr = process.stderr.write
  process.stdout.write = (chunk) => {
    output.stdout += chunk.toString()
    return true
  }
  process.stderr.write = (chunk) => {
    output.stderr += chunk.toString()
    return true
  }
  try {
    await withSearchApp(
      f,
      async ({ base, calls }) => {
        const body = await expectSearchError(
          await searchRequest(base, f),
          500,
          'INTERNAL_SERVER_ERROR'
        )
        assert.equal(body.error.message, '서버 오류로 검색을 처리하지 못했습니다.')
        assert.equal(calls.length, 0)
        const after = await snapshot(source, f)
        const didCommit = phase === 'commit' && applied
        if (didCommit) {
          const didActivityAdvance = after.session.last_active_at > before.session.last_active_at
          assert(didActivityAdvance)
          assert.deepEqual(after.user, before.user)
          assert.deepEqual(after.tokens, before.tokens)
        } else {
          assert.deepEqual(after, before)
        }
        // 실패에 예약이 없음을 이후 10번 허용으로 직접 확인한다.
        fail = false
        for (let count = 0; count < 10; count += 1) {
          assert.equal((await searchRequest(base, f)).status, 200)
        }
        await expectSearchError(await searchRequest(base, f), 429, 'SEARCH_RATE_LIMITED')
        assert.equal(calls.length, 10)
      },
      { createQueryRunner }
    )
  } finally {
    process.stdout.write = writeOut
    process.stderr.write = writeErr
  }
  for (const secret of [
    f.token.accessToken,
    f.initial.refreshToken,
    f.identity.subject,
    f.initial.user.id,
    source.options.password,
    'synthetic-search-key',
    'synthetic private'
  ]) {
    assert.equal(output.stdout.includes(secret), false)
    assert.equal(output.stderr.includes(secret), false)
  }
}

async function refusedConnection(source) {
  const f = await searchFixture(source)
  const before = await snapshot(source, f)
  // initialize하지 않은 source는 연결 실패 전용이다. 실제 migrated source의 state로 비교한다.
  const unavailable = new DataSource({ ...source.options, port: 1 })
  await withSearchApp(
    f,
    async ({ base, calls }) => {
      for (let count = 0; count < 11; count += 1) {
        await expectSearchError(await searchRequest(base, f), 500, 'INTERNAL_SERVER_ERROR')
      }
      assert.equal(calls.length, 0)
    },
    { dataSource: unavailable }
  )
  assert.deepEqual(await snapshot(source, f), before)
}

async function upstreamRetention(source, kind) {
  const f = await searchFixture(source)
  const before = await snapshot(source, f)
  await withSearchApp(f, async ({ base, calls, upstream }) => {
    const isTimeout = kind === 'timeout'
    const isInvalid = kind === 'invalid-candidate'
    let closed = false
    if (isTimeout) {
      upstream.respond = (_request, response) => {
        response.once('close', () => {
          closed = true
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.write('{"rows":[')
      }
    } else if (isInvalid) {
      upstream.body = {
        rows: [{ characterId: 'x', characterName: 'ab', serverId: 'cain', fame: '0' }]
      }
    }
    const started = performance.now()
    const first = await searchRequest(base, f)
    if (isTimeout) {
      await expectSearchError(first, 504, 'NEOPLE_TIMEOUT')
      const duration = performance.now() - started
      const reachedTimeoutDuration = duration >= 4900
      assert(reachedTimeoutDuration)
      await waitFor(() => {
        const isUpstreamClosed = closed
        return isUpstreamClosed
      }, 'upstream body socket was not cancelled')
    } else if (isInvalid) {
      await expectSearchError(first, 502, 'NEOPLE_API_ERROR')
    } else {
      assert.equal(first.status, 200)
      assert.deepEqual(await first.json(), { rows: [] })
    }
    const after = await snapshot(source, f)
    const didActivityAdvance = after.session.last_active_at > before.session.last_active_at
    assert(didActivityAdvance)
    upstream.respond = undefined
    upstream.body = { rows: [] }
    for (let count = 1; count < 10; count += 1) {
      assert.equal((await searchRequest(base, f)).status, 200)
    }
    await expectSearchError(await searchRequest(base, f), 429, 'SEARCH_RATE_LIMITED')
    assert.equal(calls.length, 10)
  })
}

async function upstreamCodes(source) {
  const f = await searchFixture(source)
  await withSearchApp(f, async ({ base, calls, upstream }) => {
    for (const [http, code, status, error] of [
      [401, 'API003', 500, 'INTERNAL_SERVER_ERROR'],
      [400, 'API002', 503, 'NEOPLE_UNAVAILABLE'],
      [503, 'API901', 502, 'NEOPLE_API_ERROR'],
      [503, 'unclassified', 503, 'NEOPLE_UNAVAILABLE']
    ]) {
      upstream.status = http
      upstream.body = { error: { code, message: 'synthetic upstream credential canary' } }
      const body = await expectSearchError(await searchRequest(base, f), status, error)
      assert.equal(JSON.stringify(body).includes('synthetic upstream'), false)
    }
    assert.equal(calls.length, 4)
  })
}

export async function assertSearchFailures(source, mark) {
  const cases = [
    [
      'connection refused remains search 500 and does not consume quota',
      () => refusedConnection(source)
    ],
    ...['read', 'write'].map((phase) => [
      `${phase} failure leaves database and quota unchanged`,
      () => databaseFailure(source, phase, false)
    ]),
    ...[false, true].map((applied) => [
      `unknown commit acknowledgement applied=${applied} stays 500 and unreserved`,
      () => databaseFailure(source, 'commit', applied)
    ]),
    ...['empty', 'invalid-candidate', 'timeout'].map((kind) => [
      `${kind} upstream result retains activity and reservation`,
      () => upstreamRetention(source, kind)
    ]),
    [
      'existing adapter error priority remains sanitized JSON over authenticated HTTP',
      () => upstreamCodes(source)
    ]
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  return cases.length
}
