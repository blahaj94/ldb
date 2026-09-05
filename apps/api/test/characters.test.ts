import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createNeopleCharacterSearchForTest,
  NeopleSearchFailure,
} from '../src/characters/neople-character-search.js'
import { NEOPLE_SERVER_NAMES } from '../src/characters/servers.js'

const input = { characterName: '가나다', serverId: 'cain', limit: 10 }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function rawResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

async function expectFailure(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message: string,
): Promise<NeopleSearchFailure> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof NeopleSearchFailure)
    assert.equal(error.status, status)
    assert.deepEqual(error.body, { error: { code, message } })
    return error
  }
  assert.fail('expected search to fail')
}

test('exports the complete official server map without prototype matches', () => {
  assert.deepEqual([...NEOPLE_SERVER_NAMES], [
    ['anton', '안톤'],
    ['bakal', '바칼'],
    ['cain', '카인'],
    ['casillas', '카시야스'],
    ['diregie', '디레지에'],
    ['hilder', '힐더'],
    ['prey', '프레이'],
    ['siroco', '시로코'],
  ])
  assert.equal(NEOPLE_SERVER_NAMES.get('all'), undefined)
  assert.equal(NEOPLE_SERVER_NAMES.get('constructor'), undefined)
  assert.equal(NEOPLE_SERVER_NAMES.get('__proto__'), undefined)
})

test('projects valid rows in order to exactly five fields and preserves values', async () => {
  const search = createNeopleCharacterSearchForTest('fake-key', {
    fetch: async () =>
      jsonResponse({
        ignored: true,
        rows: [
          {
            characterId: ' id-1 ',
            characterName: ' 이름 ',
            serverId: 'cain',
            serverName: 'wrong upstream name',
            fame: 0,
            extra: 'ignored',
          },
          {
            characterId: 'id-2',
            characterName: '둘째',
            serverId: 'future-server',
            fame: -1.5,
          },
          {
            characterId: 'id-3',
            characterName: '셋째',
            serverId: 'constructor',
            fame: null,
          },
          { characterId: 'id-4', characterName: '넷째', serverId: '__proto__' },
        ],
      }),
  })

  const result = await search(input)

  assert.deepEqual(result, {
    rows: [
      {
        characterId: ' id-1 ',
        characterName: ' 이름 ',
        serverId: 'cain',
        serverName: '카인',
        fame: 0,
      },
      {
        characterId: 'id-2',
        characterName: '둘째',
        serverId: 'future-server',
        serverName: null,
        fame: -1.5,
      },
      {
        characterId: 'id-3',
        characterName: '셋째',
        serverId: 'constructor',
        serverName: null,
        fame: null,
      },
      {
        characterId: 'id-4',
        characterName: '넷째',
        serverId: '__proto__',
        serverName: null,
        fame: null,
      },
    ],
  })
  for (const row of result.rows) {
    assert.deepEqual(Object.keys(row), [
      'characterId',
      'characterName',
      'serverId',
      'serverName',
      'fame',
    ])
  }
})

test('accepts an empty rows array', async () => {
  const search = createNeopleCharacterSearchForTest('fake-key', {
    fetch: async () => jsonResponse({ rows: [] }),
  })

  assert.deepEqual(await search(input), { rows: [] })
})

test('rejects invalid response structures and every invalid candidate', async (t) => {
  const valid = { characterId: 'id', characterName: '이름', serverId: 'cain', fame: 1 }
  const invalidBodies: Array<[string, string]> = [
    ['top-level null', 'null'],
    ['top-level array', '[]'],
    ['missing rows', '{}'],
    ['non-array rows', '{"rows":{}}'],
    ['null candidate', '{"rows":[null]}'],
    ['array candidate', '{"rows":[[]]}'],
    ['missing characterId', JSON.stringify({ rows: [{ ...valid, characterId: undefined }] })],
    ['non-string characterName', JSON.stringify({ rows: [{ ...valid, characterName: 1 }] })],
    ['blank characterId', JSON.stringify({ rows: [{ ...valid, characterId: '  ' }] })],
    ['blank characterName', JSON.stringify({ rows: [{ ...valid, characterName: '\u00a0' }] })],
    ['blank serverId', JSON.stringify({ rows: [{ ...valid, serverId: '' }] })],
    ['string fame', JSON.stringify({ rows: [{ ...valid, fame: '0' }] })],
    ['boolean fame', JSON.stringify({ rows: [{ ...valid, fame: false }] })],
    ['object fame', JSON.stringify({ rows: [{ ...valid, fame: {} }] })],
    ['array fame', JSON.stringify({ rows: [{ ...valid, fame: [] }] })],
    ['non-finite fame', '{"rows":[{"characterId":"id","characterName":"이름","serverId":"cain","fame":1e400}]}'],
  ]

  for (const [name, body] of invalidBodies) {
    await t.test(name, async () => {
      const search = createNeopleCharacterSearchForTest('fake-key', {
        fetch: async () => rawResponse(body),
      })
      await expectFailure(
        search(input),
        502,
        'NEOPLE_API_ERROR',
        '캐릭터 검색 중 오류가 발생했습니다.',
      )
    })
  }
})

test('one invalid candidate rejects the whole response without partial rows', async () => {
  const upstreamBody = {
    rows: [
      { characterId: 'valid', characterName: '정상', serverId: 'cain', fame: 1 },
      { characterId: 'invalid', characterName: '오류', serverId: 'cain', fame: '1' },
    ],
  }
  const search = createNeopleCharacterSearchForTest('fake-key', {
    fetch: async () => jsonResponse(upstreamBody),
  })

  const error = await expectFailure(
    search(input),
    502,
    'NEOPLE_API_ERROR',
    '캐릭터 검색 중 오류가 발생했습니다.',
  )
  assert.equal(JSON.stringify(error).includes('valid'), false)
})

test('known exact upstream codes override every HTTP status including 2xx', async (t) => {
  const cases: Array<[string, number, string, string]> = [
    ['API000', 500, 'INTERNAL_SERVER_ERROR', '서버 오류로 검색을 처리하지 못했습니다.'],
    ['API003', 500, 'INTERNAL_SERVER_ERROR', '서버 오류로 검색을 처리하지 못했습니다.'],
    ['API004', 500, 'INTERNAL_SERVER_ERROR', '서버 오류로 검색을 처리하지 못했습니다.'],
    ['API005', 500, 'INTERNAL_SERVER_ERROR', '서버 오류로 검색을 처리하지 못했습니다.'],
    ['API002', 503, 'NEOPLE_UNAVAILABLE', '현재 캐릭터 검색을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'],
    ['API008', 503, 'NEOPLE_UNAVAILABLE', '현재 캐릭터 검색을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'],
    ['DNF980', 503, 'NEOPLE_UNAVAILABLE', '현재 캐릭터 검색을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'],
    ['API901', 502, 'NEOPLE_API_ERROR', '캐릭터 검색 중 오류가 발생했습니다.'],
    ['DNF901', 502, 'NEOPLE_API_ERROR', '캐릭터 검색 중 오류가 발생했습니다.'],
    ['DNF000', 502, 'NEOPLE_API_ERROR', '캐릭터 검색 중 오류가 발생했습니다.'],
    ['API006', 502, 'NEOPLE_API_ERROR', '캐릭터 검색 중 오류가 발생했습니다.'],
    ['API007', 502, 'NEOPLE_API_ERROR', '캐릭터 검색 중 오류가 발생했습니다.'],
    ['API900', 502, 'NEOPLE_API_ERROR', '캐릭터 검색 중 오류가 발생했습니다.'],
    ['API999', 502, 'NEOPLE_API_ERROR', '캐릭터 검색 중 오류가 발생했습니다.'],
    ['DNF999', 502, 'NEOPLE_API_ERROR', '캐릭터 검색 중 오류가 발생했습니다.'],
  ]

  for (const [upstreamCode, status, code, message] of cases) {
    await t.test(upstreamCode, async () => {
      const search = createNeopleCharacterSearchForTest('fake-key', {
        fetch: async () =>
          jsonResponse(
            {
              error: { code: upstreamCode, status: 503, message: 'private upstream detail' },
              rows: [],
            },
            200,
          ),
      })
      const error = await expectFailure(search(input), status, code, message)
      const exposed = JSON.stringify(error.body)
      assert.equal(exposed.includes('private upstream detail'), false)
      assert.equal(exposed.includes('fake-key'), false)
      assert.deepEqual(Object.keys(error.body), ['error'])
      assert.deepEqual(Object.keys(error.body.error), ['code', 'message'])
    })
  }
})

test('unknown, non-exact, missing codes and HTTP failures use status fallback', async (t) => {
  const cases: Array<[string, unknown, number, number, string]> = [
    ['unknown on 503', { error: { code: 'FUTURE' } }, 503, 503, 'NEOPLE_UNAVAILABLE'],
    ['unknown on 429', { error: { code: 'FUTURE' } }, 429, 503, 'NEOPLE_UNAVAILABLE'],
    ['lowercase known code', { error: { code: 'api002' } }, 400, 502, 'NEOPLE_API_ERROR'],
    ['known code with whitespace', { error: { code: 'API002 ' } }, 400, 502, 'NEOPLE_API_ERROR'],
    ['error.status is ignored', { error: { status: 503 } }, 400, 502, 'NEOPLE_API_ERROR'],
    ['error exists with rows', { error: null, rows: [] }, 200, 502, 'NEOPLE_API_ERROR'],
    ['valid rows on non-2xx', { rows: [] }, 500, 502, 'NEOPLE_API_ERROR'],
  ]

  for (const [name, body, upstreamStatus, status, code] of cases) {
    await t.test(name, async () => {
      const search = createNeopleCharacterSearchForTest('fake-key', {
        fetch: async () => jsonResponse(body, upstreamStatus),
      })
      await expectFailure(
        search(input),
        status,
        code,
        code === 'NEOPLE_UNAVAILABLE'
          ? '현재 캐릭터 검색을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'
          : '캐릭터 검색 중 오류가 발생했습니다.',
      )
    })
  }
})

test('malformed JSON uses HTTP fallback while body read and transport failures are 502', async () => {
  const malformed503 = createNeopleCharacterSearchForTest('fake-key', {
    fetch: async () => rawResponse('not json', 503),
  })
  await expectFailure(
    malformed503(input),
    503,
    'NEOPLE_UNAVAILABLE',
    '현재 캐릭터 검색을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  )

  const bodyFailure503 = createNeopleCharacterSearchForTest('fake-key', {
    fetch: async () =>
      ({ status: 503, text: async () => Promise.reject(new Error('private body failure')) }) as Response,
  })
  await expectFailure(
    bodyFailure503(input),
    502,
    'NEOPLE_API_ERROR',
    '캐릭터 검색 중 오류가 발생했습니다.',
  )

  const transportFailure = createNeopleCharacterSearchForTest('fake-key', {
    fetch: async () => Promise.reject(new Error('private transport failure')),
  })
  await expectFailure(
    transportFailure(input),
    502,
    'NEOPLE_API_ERROR',
    '캐릭터 검색 중 오류가 발생했습니다.',
  )
})

test('full body completion at the exact deadline is a timeout and schedules 5,000ms', async () => {
  let now = 0
  let cleared = 0
  let scheduledDelay: number | undefined
  const search = createNeopleCharacterSearchForTest('fake-key', {
    fetch: async () =>
      ({
        status: 200,
        ok: true,
        text: async () => {
          now = 5_000
          return JSON.stringify({
            rows: [{ characterId: 'id', characterName: '이름', serverId: 'cain', fame: 1 }],
          })
        },
      }) as Response,
    now: () => now,
    setTimer: (_callback, delay) => {
      scheduledDelay = delay
      return Symbol('timer')
    },
    clearTimer: () => {
      cleared += 1
    },
  })

  await expectFailure(
    search(input),
    504,
    'NEOPLE_TIMEOUT',
    '캐릭터 검색 응답 시간이 초과됐습니다. 다시 시도해 주세요.',
  )
  assert.equal(scheduledDelay, 5_000)
  assert.equal(cleared, 1)
})

test('a fully parsed and projected response at 4,999ms succeeds', async () => {
  let now = 0
  let scheduledDelay: number | undefined
  const search = createNeopleCharacterSearchForTest('fake-key', {
    fetch: async () =>
      ({
        status: 200,
        ok: true,
        text: async () => {
          now = 4_999
          return JSON.stringify({
            rows: [{ characterId: 'id', characterName: '이름', serverId: 'cain', fame: 1 }],
          })
        },
      }) as Response,
    now: () => now,
    setTimer: (_callback, delay) => {
      scheduledDelay = delay
      return Symbol('timer')
    },
    clearTimer: () => undefined,
  })

  assert.deepEqual(await search(input), {
    rows: [
      {
        characterId: 'id',
        characterName: '이름',
        serverId: 'cain',
        serverName: '카인',
        fame: 1,
      },
    ],
  })
  assert.equal(scheduledDelay, 5_000)
})

test('deadline aborts the request, wins over a late known code, and performs no retry', async () => {
  let callback: (() => void) | undefined
  let calls = 0
  const search = createNeopleCharacterSearchForTest('fake-key', {
    fetch: async (_url, init) => {
      calls += 1
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
          resolve(jsonResponse({ error: { code: 'API003' } }))
        })
      })
    },
    now: () => 0,
    setTimer: (handler) => {
      callback = handler
      return Symbol('timer')
    },
    clearTimer: () => undefined,
  })

  const pending = search(input)
  await Promise.resolve()
  assert(callback)
  callback()

  await expectFailure(
    pending,
    504,
    'NEOPLE_TIMEOUT',
    '캐릭터 검색 응답 시간이 초과됐습니다. 다시 시도해 주세요.',
  )
  assert.equal(calls, 1)
})

test('concurrent searches keep controller, timer, and result state independent', async () => {
  const timers: Array<{ callback: () => void; cleared: boolean }> = []
  let calls = 0
  const search = createNeopleCharacterSearchForTest('fake-key', {
    fetch: async (request, init) => {
      calls += 1
      const name = new URL(request).searchParams.get('characterName')
      if (name === '빠른검색') {
        return jsonResponse({
          rows: [{ characterId: 'fast', characterName: name, serverId: 'cain', fame: 0 }],
        })
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    },
    now: () => 0,
    setTimer: (callback) => {
      const timer = { callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      ;(timer as { cleared: boolean }).cleared = true
    },
  })

  const slow = search({ ...input, characterName: '느린검색' })
  const fast = search({ ...input, characterName: '빠른검색' })
  assert.deepEqual(await fast, {
    rows: [
      {
        characterId: 'fast',
        characterName: '빠른검색',
        serverId: 'cain',
        serverName: '카인',
        fame: 0,
      },
    ],
  })
  assert.equal(timers[1]?.cleared, true)
  assert.equal(timers[0]?.cleared, false)
  timers[0]?.callback()
  await expectFailure(
    slow,
    504,
    'NEOPLE_TIMEOUT',
    '캐릭터 검색 응답 시간이 초과됐습니다. 다시 시도해 주세요.',
  )
  assert.equal(calls, 2)
})
