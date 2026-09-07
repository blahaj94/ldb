import assert from 'node:assert/strict'
import { test } from 'node:test'

// Pure parser와 HTTP original URL 경계를 각각 검증한다. DB cancellation 선택과 독립적이다.
test('search query decodes exactly once and applies defaults only to omitted fields', async () => {
  const { parseCharacterSearchQuery } = await import('../dist/characters/query.js')
  for (const [query, expected] of [
    ['characterName=ab', { characterName: 'ab', serverId: 'all', limit: 10 }],
    ['characterName=ab&serverId=cain&limit=0001', { characterName: 'ab', serverId: 'cain', limit: 1 }],
    ['characterName=ab&limit=200', { characterName: 'ab', serverId: 'all', limit: 200 }],
    ['characterName=a+b', { characterName: 'a b', serverId: 'all', limit: 10 }],
    ['characterName=a=b', { characterName: 'a=b', serverId: 'all', limit: 10 }],
    ['characterName=%255B%255D', { characterName: '%5B%5D', serverId: 'all', limit: 10 }],
    ['characterName=%5B%5D', { characterName: '[]', serverId: 'all', limit: 10 }],
  ]) {
    assert.deepEqual(parseCharacterSearchQuery(`/characters?${query}`), expected)
  }
})

test('search query counts Unicode code points without normalization', async () => {
  const { parseCharacterSearchQuery } = await import('../dist/characters/query.js')
  for (const characterName of ['가나', '😀가', '가', '😀'.repeat(12)]) {
    assert.deepEqual(parseCharacterSearchQuery(`/characters?characterName=${encodeURIComponent(characterName)}`), {
      characterName, serverId: 'all', limit: 10,
    })
  }
  for (const characterName of ['😀', '😀'.repeat(13), '\u00a0ab', 'ab\u3000']) {
    assert.throws(
      () => parseCharacterSearchQuery(`/characters?characterName=${encodeURIComponent(characterName)}`),
      { status: 400, body: { error: { code: 'INVALID_SEARCH_QUERY', message: '검색 조건을 확인해 주세요.' } } },
    )
  }
})
