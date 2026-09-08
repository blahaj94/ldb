/* global fetch */
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { Buffer } from 'node:buffer'
import { test } from 'node:test'
import { createLoginHttpApp } from '../dist/auth/login/http.js'

const unusedLogin = Object.fromEntries(
  ['create', 'authorize', 'callback', 'exchange'].map((name) => [
    name,
    async () => {
      throw new Error('unrelated login route called')
    }
  ])
)
const principal = {
  userId: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  tokenId: '00000000-0000-4000-8000-000000000003',
  issuedAt: 1,
  expiresAt: 900
}

async function withSearchBoundary(
  operation,
  { validJwt = true, apiKey = 'synthetic-search-key' } = {}
) {
  const calls = { verification: 0, database: 0, upstream: 0 }
  const deps = {
    apiKey,
    dataSource: {},
    createQueryRunner() {
      calls.database += 1
      throw new Error('unexpected database call')
    },
    async verifyAccessJwt() {
      calls.verification += 1
      if (!validJwt) {
        throw new Error('private verifier canary')
      }
      return principal
    },
    async searchCharacters() {
      calls.upstream += 1
      throw new Error('unexpected upstream call')
    }
  }
  const app = await createLoginHttpApp(unusedLogin, undefined, undefined, deps)
  await app.listen(0, '127.0.0.1')
  try {
    await operation(await app.getUrl(), calls)
  } finally {
    await app.close()
  }
  assert.equal(calls.database, 0)
  assert.equal(calls.upstream, 0)
}

function rawGet(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const pending = request(`${base}${path}`, { method: 'GET', headers }, (response) => {
      const parts = []
      response.on('data', (part) => parts.push(part))
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(parts).toString('utf8')
        })
      )
    })
    pending.once('error', reject)
    pending.end()
  })
}

function expectSearchError(response, status, code, message) {
  assert.equal(response.status, status)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.match(response.headers['content-type'], /^application\/json/)
  assert.deepEqual(JSON.parse(response.body), { error: { code, message } })
  assert.doesNotMatch(
    response.body,
    /synthetic-search-key|private verifier canary|stack|<!doctype/i
  )
}

const authorization = { authorization: 'Bearer synthetic-access-value' }
const authMessage = '로그인이 필요합니다.'
const queryMessage = '검색 조건을 확인해 주세요.'

test('search requires one exact Bearer header before invalid raw query or configuration', async () => {
  await withSearchBoundary(
    async (base, calls) => {
      for (const headers of [
        {},
        { authorization: 'Basic invalid' },
        { authorization: 'bearer invalid' },
        { authorization: 'Bearer' },
        { authorization: 'Bearer first second' },
        { authorization: 'Bearer first,second' },
        { authorization: ['Bearer first', 'Bearer second'] }
      ]) {
        const response = await rawGet(
          base,
          '/characters?limit=%FF&accessToken=query-token',
          headers
        )
        expectSearchError(response, 401, 'AUTHENTICATION_REQUIRED', authMessage)
      }
      assert.equal(calls.verification, 0)
    },
    { apiKey: '' }
  )
})

test('search verifier rejection stays sanitized JSON ahead of query and config', async () => {
  await withSearchBoundary(
    async (base, calls) => {
      const response = await rawGet(base, '/characters?unknown=%FF', authorization)
      expectSearchError(response, 401, 'AUTHENTICATION_REQUIRED', authMessage)
      assert.equal(calls.verification, 1)
    },
    { validJwt: false, apiKey: '' }
  )
})

test('search original URL rejects malformed structure and strict UTF-8 before configuration', async () => {
  const invalidQueries = [
    '',
    'characterName=',
    'characterName=a',
    `characterName=${'a'.repeat(13)}`,
    'characterName=%20ab',
    'characterName=ab+',
    'characterName=ab&characterName=cd',
    'characterName=ab&%63haracterName=cd',
    'characterName=ab&limit=1&%6Cimit=2',
    'characterName=ab&serverId=all&serverId=cain',
    'characterName=ab&limit[]=1',
    'characterName=ab&limit%5B0%5D=1',
    'characterName[x]=ab',
    'characterName=ab&unknown=x',
    'characterName=ab&&limit=1',
    'characterName=ab&',
    'characterName=%',
    'characterName=%GG',
    'characterName=%C0%AF',
    'characterName=%ED%A0%80',
    'characterName=%F4%90%80%80',
    'characterName=%FF',
    'characterName=ab&serverId=',
    'characterName=ab&serverId=CAIN',
    'characterName=ab&serverId=future-server',
    'characterName=ab&limit=',
    'characterName=ab&limit=0',
    'characterName=ab&limit=201',
    'characterName=ab&limit=-1',
    'characterName=ab&limit=1.0',
    'characterName=ab&limit=1e2',
    'characterName=ab&limit=%EF%BC%91'
  ]
  await withSearchBoundary(
    async (base, calls) => {
      for (const query of invalidQueries) {
        const response = await rawGet(base, `/characters?${query}`, authorization)
        expectSearchError(response, 400, 'INVALID_SEARCH_QUERY', queryMessage)
      }
      assert.equal(calls.verification, invalidQueries.length)
    },
    { apiKey: '' }
  )
})

test('search valid raw query reaches configuration failure without database or upstream', async () => {
  await withSearchBoundary(
    async (base, calls) => {
      const response = await rawGet(base, '/characters?characterName=ab', authorization)
      expectSearchError(
        response,
        500,
        'INTERNAL_SERVER_ERROR',
        '서버 오류로 검색을 처리하지 못했습니다.'
      )
      assert.equal(calls.verification, 1)
    },
    { apiKey: '' }
  )
})

test('search HEAD fallback cannot verify, record activity or consume quota', async () => {
  await withSearchBoundary(async (base, calls) => {
    const response = await fetch(`${base}/characters?characterName=ab`, {
      method: 'HEAD',
      headers: authorization
    })
    assert.equal(response.status, 400)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(await response.text(), '')
    assert.equal(calls.verification, 0)
  })
})
