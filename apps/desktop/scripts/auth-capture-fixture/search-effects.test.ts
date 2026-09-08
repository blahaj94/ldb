import { expect, it } from 'vitest'
import { createAuthHarness } from '../../src/backend/auth/auth-test-fixtures'
import { createFixtureSearch, type SearchScenario } from './search-effects'

function fixture(): ReturnType<typeof createFixtureSearch> {
  return createFixtureSearch({
    apiOrigin: 'https://api.example.test',
    clock: createAuthHarness().clock
  })
}
function request(signal?: AbortSignal): Request {
  return new Request('https://api.example.test/characters?characterName=ALICE', {
    headers: { authorization: 'Bearer synthetic.payload.signature' },
    signal
  })
}

it.each([
  ['success', 200, null],
  ['empty', 200, null],
  ['failure', 500, null],
  ['rate-limit', 429, '5']
] as const)('%s 고정 시나리오는 다음 요청에만 적용한다', async (scenario, status, retryAfter) => {
  const search = fixture()
  search.selectScenario(scenario)
  const response = await search.runtime.fetch(request())
  expect(response.status).toBe(status)
  expect(response.headers.get('Retry-After')).toBe(retryAfter)
  const body = await response.json()
  const isSuccess = scenario === 'success'
  const isEmpty = scenario === 'empty'
  if (isSuccess) {
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toEqual({
      characterId: 'synthetic-character',
      characterName: 'ALICE',
      serverId: 'cain',
      serverName: '카인',
      fame: 12345
    })
  } else if (isEmpty) {
    expect(body).toEqual({ rows: [] })
  } else {
    expect(body.error.code).toEqual(expect.any(String))
  }
})

it('고정 origin·path·method·query·합성 access를 벗어나면 실제 fetch 없이 거절한다', async () => {
  const search = fixture()
  const original = request()
  const invalid = [
    new Request('https://outside.example.test/characters?characterName=ALICE', original),
    new Request('https://api.example.test/private?characterName=ALICE', original),
    new Request('https://api.example.test/characters?characterName=ALICE&limit=1', original),
    new Request(original, { method: 'POST' }),
    new Request(original, { headers: {} })
  ]
  for (const input of invalid) {
    await expect(search.runtime.fetch(input)).rejects.toThrow('Search fixture request denied')
  }
  expect(search.runtime.fetch).not.toBe(globalThis.fetch)
})

it('pending 시나리오는 다른 선택으로 자동 완료되지 않고 요청의 abort로만 종료한다', async () => {
  const search = fixture()
  search.selectScenario('pending')
  const controller = new AbortController()
  const pending = search.runtime.fetch(request(controller.signal))
  search.selectScenario('success' satisfies SearchScenario)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect((await search.runtime.fetch(request())).status).toBe(200)
})

it('합성 응답 묶음과 비민감 counter는 HTTP 호출 순서만 기록하고 slot 의미를 만들지 않는다', async () => {
  const search = fixture()
  const observed = search as typeof search & {
    counts: { requests: number; pendingAborts: number }
    queueScenarios: (scenarios: readonly SearchScenario[]) => void
  }
  expect(observed.queueScenarios).toBeTypeOf('function')
  observed.queueScenarios(['failure', 'failure', 'pending', 'rate-limit'])
  expect(observed.counts).toEqual({ requests: 0, pendingAborts: 0 })
  const first = await search.runtime.fetch(request())
  const second = await search.runtime.fetch(request())
  const controller = new AbortController()
  const pending = search.runtime.fetch(request(controller.signal))
  const limited = await search.runtime.fetch(request())
  expect([first.status, second.status, limited.status]).toEqual([500, 500, 429])
  expect(observed.counts).toEqual({ requests: 4, pendingAborts: 0 })
  search.selectScenario('success')
  expect(observed.counts.requests).toBe(4)
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(observed.counts).toEqual({ requests: 4, pendingAborts: 1 })
  expect((await search.runtime.fetch(request())).status).toBe(200)
  expect(observed.counts).toEqual({ requests: 5, pendingAborts: 1 })
})
