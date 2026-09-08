/* global fetch */
import assert from 'node:assert/strict'
import { assertSearchConcurrency } from './character-search-concurrency.mjs'
import { assertSearchCancellation } from './character-search-cancellation.mjs'
import { assertSearchSessionBoundaries } from './character-search-session-boundaries.mjs'
import { assertSearchFailures } from './character-search-failures.mjs'
import {
  searchFixture,
  withSearchApp,
  searchRequest,
  expectSearchError,
  snapshot
} from './character-search-fixtures.mjs'

async function authenticatedSearch(source) {
  const f = await searchFixture(source)
  const before = await snapshot(source, f)
  await withSearchApp(f, async ({ base, calls, upstream }) => {
    upstream.body = {
      rows: [
        {
          characterId: 'candidate',
          characterName: '가나',
          serverId: 'cain',
          fame: 0,
          privateField: 'excluded'
        },
        { characterId: 'future', characterName: 'other', serverId: 'future-server', fame: null }
      ]
    }
    const response = await searchRequest(base, f, 'characterName=%EA%B0%80%EB%82%98')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      rows: [
        {
          characterId: 'candidate',
          characterName: '가나',
          serverId: 'cain',
          serverName: '카인',
          fame: 0
        },
        {
          characterId: 'future',
          characterName: 'other',
          serverId: 'future-server',
          serverName: null,
          fame: null
        }
      ]
    })
    assert.deepEqual(calls, [
      {
        path: '/df/servers/all/characters',
        query: { characterName: '가나', limit: '10', wordType: 'full' },
        hasExpectedKey: true
      }
    ])
  })
  const after = await snapshot(source, f)
  assert(after.session.last_active_at > before.session.last_active_at)
  assert.equal(after.session.last_active_at.getMilliseconds(), 0)
  assert.deepEqual(after.user, before.user)
  assert.deepEqual(after.tokens, before.tokens)
}

async function initialRejections(source) {
  const f = await searchFixture(source)
  const before = await snapshot(source, f)
  await withSearchApp(
    f,
    async ({ base, calls }) => {
      await expectSearchError(
        await fetch(`${base}/characters?unknown=%FF`),
        401,
        'AUTHENTICATION_REQUIRED'
      )
      await expectSearchError(
        await searchRequest(base, f, 'characterName=ab&limit=1&%6Cimit=2'),
        400,
        'INVALID_SEARCH_QUERY'
      )
      await expectSearchError(
        await searchRequest(base, f, 'characterName=%FF'),
        400,
        'INVALID_SEARCH_QUERY'
      )
      assert.deepEqual(calls, [])
    },
    { apiKey: '' }
  )
  assert.deepEqual(await snapshot(source, f), before)
}

export async function assertCharacterSearchHttpIntegration(source, mark) {
  const cases = [
    [
      'real JWT and committed session activity precede loopback upstream projection',
      () => authenticatedSearch(source)
    ],
    [
      'initial auth and raw query refusals preserve all database state and upstream count',
      () => initialRejections(source)
    ]
  ]
  for (const [name, run] of cases) {
    mark(name)
    await run()
  }
  const concurrency = await assertSearchConcurrency(source, mark)
  const cancellation = await assertSearchCancellation(source, mark)
  const boundaries = await assertSearchSessionBoundaries(source, mark)
  const failures = await assertSearchFailures(source, mark)
  return cases.length + concurrency + cancellation + boundaries + failures
}
