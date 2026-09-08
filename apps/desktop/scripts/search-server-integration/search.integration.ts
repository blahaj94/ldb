import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'vitest'
import { createSearchHttp, SearchHttpFailure } from '../../src/backend/search/http'
import { withSearchServer } from './runtime.mjs'

const apiOrigin = 'https://desktop-search.test.invalid'
const nickname = 'fixture'

// 후보 값은 외부 사용자 데이터가 아닌 명시적인 synthetic fixture다.
const upstreamRows = [
  {
    characterId: 'fixture-first',
    characterName: 'fixture',
    serverId: 'cain',
    fame: 0,
    ignored: true
  },
  {
    characterId: 'fixture-second',
    characterName: 'fixture',
    serverId: 'future-server',
    fame: -1.5
  },
  { characterId: 'fixture-third', characterName: 'fixture', serverId: 'anton' }
]

test('Desktop HTTP client consumes default API, exchange JWT, activity and account quota', async () => {
  await withSearchServer(async ({ base, accessToken, source, neople }) => {
    const requests: Array<{ query: string; hasBearer: boolean }> = []
    const statuses: number[] = []
    const transport: typeof fetch = async (input, options) => {
      const request = new Request(input, options)
      const url = new URL(request.url)
      assert.equal(url.origin, apiOrigin, 'test transport must reject other origins')
      assert.equal(url.pathname, '/characters')
      requests.push({
        query: url.search,
        hasBearer: request.headers.get('authorization') === `Bearer ${accessToken}`
      })
      const response = await fetch(new Request(`${base}${url.pathname}${url.search}`, request))
      statuses.push(response.status)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      return response
    }
    const search = createSearchHttp({
      apiOrigin,
      fetch: transport,
      clock: { read: () => ({ monotonicMs: 1234, wallMs: 0, discontinuous: false }) }
    })
    const searchInput = { nickname, accessToken, signal: new AbortController().signal }
    const [before] = await source.query('SELECT last_active_at FROM auth_sessions')
    neople.upstream.body = { rows: upstreamRows }

    // 활동 인정 시각은 정수 초이므로 exchange와 다른 DB 초에서 검색한다.
    await delay(1100)
    const rows = await search(searchInput)

    assert.deepEqual(rows, [
      {
        characterId: 'fixture-first',
        characterName: nickname,
        serverId: 'cain',
        serverName: '카인',
        fame: 0
      },
      {
        characterId: 'fixture-second',
        characterName: nickname,
        serverId: 'future-server',
        serverName: null,
        fame: -1.5
      },
      {
        characterId: 'fixture-third',
        characterName: nickname,
        serverId: 'anton',
        serverName: '안톤',
        fame: null
      }
    ])
    assert.deepEqual(requests, [{ query: '?characterName=fixture', hasBearer: true }])
    assert.deepEqual(neople.calls, [
      {
        path: '/df/servers/all/characters',
        query: { characterName: nickname, limit: '10', wordType: 'full' },
        hasExpectedKey: true
      }
    ])
    const [after] = await source.query('SELECT last_active_at FROM auth_sessions')
    assert(
      after.last_active_at.getTime() > before.last_active_at.getTime(),
      'search must commit session activity'
    )

    neople.upstream.body = { rows: [] }
    assert.deepEqual(await search(searchInput), [])
    neople.upstream.body = { rows: [upstreamRows[0], { ...upstreamRows[1], fame: '0' }] }
    await assert.rejects(search(searchInput), { code: 'NEOPLE_API_ERROR' })
    assert.deepEqual(statuses, [200, 200, 502])
    assert.equal(neople.calls.length, 3, 'invalid upstream response is not retried')

    await assert.rejects(search({ ...searchInput, nickname: 'x' }), {
      code: 'INVALID_SEARCH_QUERY'
    })
    await assert.rejects(search({ ...searchInput, accessToken: 'synthetic-invalid-access' }), {
      code: 'AUTHENTICATION_REQUIRED'
    })
    assert.deepEqual(statuses.slice(-2), [400, 401])
    assert.equal(neople.calls.length, 3, 'input and JWT rejection must not reach upstream')

    neople.upstream.body = { rows: [] }
    for (let request = 3; request < 10; request += 1) {
      assert.deepEqual(await search(searchInput), [])
    }
    const [beforeQuota] = await source.query('SELECT last_active_at FROM auth_sessions')
    await assert.rejects(search(searchInput), (error: unknown) => {
      assert(error instanceof SearchHttpFailure)
      assert.equal(error.code, 'SEARCH_RATE_LIMITED')
      assert.equal(error.retryAfterReceivedAt, 1234)
      const seconds = error.retryAfterSeconds
      const hasSeconds = seconds != null
      const isSafeInteger = Number.isSafeInteger(seconds)
      const isInServerWindow = hasSeconds && seconds > 0 && seconds <= 60
      const hasValidWait = hasSeconds && isSafeInteger && isInServerWindow
      assert(hasValidWait, 'Desktop must consume the real account Retry-After header')
      return true
    })
    assert.equal(statuses.at(-1), 429)
    assert.equal(neople.calls.length, 10, 'quota rejection must not retry or call upstream')
    const [afterQuota] = await source.query('SELECT last_active_at FROM auth_sessions')
    assert.equal(afterQuota.last_active_at.getTime(), beforeQuota.last_active_at.getTime())
  })
})
