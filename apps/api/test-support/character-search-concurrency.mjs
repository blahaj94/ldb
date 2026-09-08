import assert from 'node:assert/strict'
import { setTimeout, clearTimeout } from 'node:timers'
import {
  searchFixture,
  withSearchApp,
  searchRequest,
  expectSearchError,
  snapshot,
  observeSearchRunners,
  waitFor
} from './character-search-fixtures.mjs'
import { createIdentitySession } from '../dist/auth/identity-session.js'
import { databaseNow } from './login-test-control.mjs'

async function additionalSession(source, f, sameAccount) {
  const identity = sameAccount
    ? f.identity
    : { provider: 'google', subject: 'synthetic-other-search-account' }
  const initial = await source.transaction('READ COMMITTED', (manager) =>
    createIdentitySession(manager, identity)
  )
  const now = await databaseNow(source)
  await source.query('UPDATE auth_sessions SET created_at=$2,last_active_at=$2 WHERE id=$1', [
    initial.session.id,
    new Date(now.getTime() - 10_000)
  ])
  const token = await f.deps.issueAccessJwt({
    userId: initial.user.id,
    sessionId: initial.session.id,
    issuedAt: now.getTime() / 1000,
    idleDeadline: now.getTime() / 1000 + 900
  })
  return { ...f, initial, token }
}

async function concurrentQuota(source) {
  const f = await searchFixture(source)
  const device = await additionalSession(source, f, true)
  const other = await additionalSession(source, f, false)
  const before = await snapshot(source, f)
  const beforeDevice = await snapshot(source, device)
  let commits = 0
  const createQueryRunner = observeSearchRunners({
    commit: async (_runner, commit) => {
      await commit()
      commits += 1
    }
  })
  await withSearchApp(
    f,
    async ({ base, calls, upstream }) => {
      const responses = []
      upstream.respond = (_request, response) => {
        responses.push(response)
      }
      const requests = Array.from({ length: 11 }, (_, index) =>
        searchRequest(base, index % 2 === 0 ? f : device, `characterName=ab&limit=${index + 1}`)
      )
      try {
        // 외부 응답을 모두 보류해도 같은 계정의 admission 10개와 초과 429는 완료되어야 한다.
        await waitFor(() => calls.length === 10)
        const rejected = await Promise.race(requests)
        await expectSearchError(rejected, 429, 'SEARCH_RATE_LIMITED')
        assert.match(rejected.headers.get('retry-after'), /^(59|60)$/)
        assert.equal(commits, 10)
        await expectSearchError(
          await searchRequest(base, f, 'characterName=ab&limit[]=1'),
          400,
          'INVALID_SEARCH_QUERY'
        )
        assert.equal(commits, 10)
        const independent = searchRequest(base, other)
        await waitFor(() => calls.length === 11)
        assert.equal(commits, 11)
        for (const response of responses) {
          response.end('{"rows":[]}')
        }
        const results = await Promise.all(requests)
        assert.equal(results.filter((response) => response.status === 200).length, 10)
        assert.equal(results.filter((response) => response.status === 429).length, 1)
        assert.equal((await independent).status, 200)
      } finally {
        for (const response of responses) {
          response.end('{"rows":[]}')
        }
        await Promise.allSettled(requests)
      }
    },
    { createQueryRunner }
  )
  assert((await snapshot(source, f)).session.last_active_at > before.session.last_active_at)
  assert(
    (await snapshot(source, device)).session.last_active_at > beforeDevice.session.last_active_at
  )
}

async function finalReservationClock(source) {
  const f = await searchFixture(source)
  let now = 0
  let yieldedAfterClock = false
  const clock = {
    now() {
      yieldedAfterClock = false
      queueMicrotask(() => {
        yieldedAfterClock = true
      })
      return now
    },
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer)
  }
  const createQueryRunner = observeSearchRunners({
    commit: async (_runner, commit) => {
      await commit()
      now = Math.max(now, 300)
    }
  })
  await withSearchApp(
    f,
    async ({ base, calls, upstream }) => {
      upstream.start = () => {
        assert.equal(yieldedAfterClock, false)
      }
      for (let count = 0; count < 10; count += 1) {
        assert.equal((await searchRequest(base, f)).status, 200)
      }
      now = 60_000
      const rejected = await searchRequest(base, f)
      await expectSearchError(rejected, 429, 'SEARCH_RATE_LIMITED')
      assert.equal(rejected.headers.get('retry-after'), '1')
      assert.equal(calls.length, 10)
      now = 60_300
      assert.equal((await searchRequest(base, f)).status, 200)
      assert.equal(calls.length, 11)
    },
    { clock, createQueryRunner }
  )
}

export async function assertSearchConcurrency(source, mark) {
  const cases = [
    [
      '11 concurrent requests sum sessions and queries while another account and upstream responses remain independent',
      () => concurrentQuota(source)
    ],
    [
      'post-commit final monotonic reservation and no microtask yield before adapter call',
      () => finalReservationClock(source)
    ]
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  return cases.length
}
