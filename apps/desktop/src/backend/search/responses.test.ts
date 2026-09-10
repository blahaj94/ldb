import { describe, expect, it, vi } from 'vitest'
import type { SearchSlot } from '../../preload/common/types/search'
import { candidate, createSearchFixture, jsonResponse } from './search-test-fixture'

type Fixture = Awaited<ReturnType<typeof createSearchFixture>>

async function completedSlot(fixture: Fixture): Promise<SearchSlot> {
  await vi.waitFor(async () => {
    expect((await fixture.read()).slots[0].state).not.toBe('pending')
  })
  return (await fixture.read()).slots[0]
}

async function searchResponse(response: Response): Promise<SearchSlot> {
  const fixture = await createSearchFixture()
  fixture.fetchSearch.mockResolvedValueOnce(response)
  const result = await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
  expect(result).toMatchObject({ ok: true })
  return completedSlot(fixture)
}

describe('검색 전체 응답과 정제 실패', () => {
  it.each([
    [400, 'INVALID_SEARCH_QUERY'],
    [500, 'INTERNAL_SERVER_ERROR'],
    [502, 'NEOPLE_API_ERROR'],
    [503, 'NEOPLE_UNAVAILABLE'],
    [504, 'NEOPLE_TIMEOUT']
  ] as const)('%s / %s는 raw message 없이 같은 정제 code를 반환한다', async (status, code) => {
    const response = jsonResponse({
      status,
      body: { error: { code, message: 'SYNTHETIC_RESPONSE_DETAIL', extra: 'discard' } }
    })

    const slot = await searchResponse(response)

    expect(slot).toMatchObject({ state: 'failure', rows: [] })
    expect(slot.error).toEqual({ code, retryAfterSeconds: null })
    expect(JSON.stringify(slot)).not.toContain('SYNTHETIC_RESPONSE_DETAIL')
  })

  it.each([
    { status: 500, body: null },
    { status: 500, body: { error: { code: 'NEOPLE_API_ERROR' } } },
    { status: 502, body: { error: { code: 'INTERNAL_SERVER_ERROR' } } },
    { status: 401, body: { error: { code: 'NEOPLE_API_ERROR' } } },
    { status: 429, body: { error: { code: 'INTERNAL_SERVER_ERROR' } } },
    { status: 200, body: { rows: [candidate], error: { code: 'NEOPLE_API_ERROR' } } },
    { status: 201, body: { rows: [candidate] } }
  ])('HTTP/code 조합 오류 %j는 정상 후보나 서버 code로 통과시키지 않는다', async (input) => {
    const slot = await searchResponse(jsonResponse(input))

    expect(slot).toMatchObject({
      state: 'failure',
      rows: [],
      error: { code: 'SEARCH_RESPONSE_INVALID', retryAfterSeconds: null }
    })
  })

  it.each([
    null,
    [],
    { rows: null },
    { rows: [null] },
    { rows: [candidate, { ...candidate, fame: '0' }] },
    { rows: [candidate, { ...candidate, characterName: '  ' }] },
    { rows: [candidate, { ...candidate, serverName: 1 }] }
  ])('전체 body 또는 후보가 부적합하면 부분 성공 없이 실패한다: %j', async (body) => {
    const slot = await searchResponse(jsonResponse({ body }))

    expect(slot).toMatchObject({
      state: 'failure',
      rows: [],
      error: { code: 'SEARCH_RESPONSE_INVALID', retryAfterSeconds: null }
    })
  })

  it.each(['{broken', '{"rows":['])(
    '정상 EOF의 malformed/truncated JSON %s는 응답 오류다',
    async (body) => {
      const slot = await searchResponse(new Response(body))

      expect(slot).toMatchObject({
        state: 'failure',
        rows: [],
        error: { code: 'SEARCH_RESPONSE_INVALID', retryAfterSeconds: null }
      })
    }
  )

  it('deadline 전 body stream의 transport 오류는 JSON 오류와 구분한다', async () => {
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.error(new TypeError('Synthetic body transport failure'))
        }
      },
      { highWaterMark: 0 }
    )

    const slot = await searchResponse(new Response(body))

    expect(slot).toMatchObject({
      state: 'failure',
      rows: [],
      error: { code: 'SEARCH_NETWORK_ERROR', retryAfterSeconds: null }
    })
  })

  it('headers 전 transport 오류도 network 실패로 종료한다', async () => {
    const fixture = await createSearchFixture()
    fixture.fetchSearch.mockRejectedValueOnce(new TypeError('Synthetic transport failure'))

    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })

    expect(await completedSlot(fixture)).toMatchObject({
      state: 'failure',
      rows: [],
      error: { code: 'SEARCH_NETWORK_ERROR', retryAfterSeconds: null }
    })
  })

  it('검색 응답에 인증 JSON의 16 KiB 상한을 적용하지 않는다', async () => {
    const row = { ...candidate, characterName: '가'.repeat(20_000) }

    const slot = await searchResponse(jsonResponse({ body: { rows: [row] } }))

    expect(slot).toMatchObject({ state: 'success', rows: [row], error: null })
  })
})

describe('검색 입력의 Unicode와 URI 원문', () => {
  it.each(['😀가', '가', '가 나', '가+나'])(
    '유효 입력 %j를 normalize/trim하지 않고 query로 전달한다',
    async (nickname) => {
      const fixture = await createSearchFixture()

      await fixture.observe({ slot: 0, observationRevision: 1, nickname })

      expect(await completedSlot(fixture)).toMatchObject({ state: 'empty', nickname })
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)
      const request = new Request(...fixture.fetchSearch.mock.calls[0])
      const url = new URL(request.url)
      expect([...url.searchParams.entries()]).toEqual([['characterName', nickname]])
    }
  )

  it.each(['가\ud800', '\udc00나'])(
    'UTF-8로 원문을 표현할 수 없는 입력 %j를 대체 문자로 바꾸어 보내지 않는다',
    async (nickname) => {
      const fixture = await createSearchFixture()

      await fixture.observe({ slot: 0, observationRevision: 1, nickname })

      expect(await completedSlot(fixture)).toMatchObject({
        state: 'failure',
        nickname,
        error: { code: 'INVALID_SEARCH_QUERY', retryAfterSeconds: null }
      })
      expect(fixture.fetchSearch).not.toHaveBeenCalled()
    }
  )
})
