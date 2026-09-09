import { describe, expect, it, vi } from 'vitest'
import { ACCESS_2, REFRESH_2, deferred, tokenResponse } from '../auth/auth-test-fixtures'
import { candidate, createSearchFixture, jsonResponse } from './search-test-fixture'

async function flushSearch(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function pendingBody(): {
  response: Response
  pull: ReturnType<typeof vi.fn>
  finish: (text: string) => void
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  const pull = vi.fn()
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value
      },
      pull,
      cancel() {
        closed = true
      }
    },
    { highWaterMark: 0 }
  )
  return {
    response: new Response(body),
    pull,
    finish: (text) => {
      if (closed) {
        return
      }
      closed = true
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  }
}

describe('검색 접수부터 전체 완료까지 하나의 monotonic 예산', () => {
  it('headers가 도착해도 body가 끝나지 않으면 접수 15초에 timeout으로 끝낸다', async () => {
    const fixture = await createSearchFixture()
    const body = pendingBody()
    fixture.fetchSearch.mockResolvedValueOnce(body.response)
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    await vi.waitFor(() => expect(body.pull).toHaveBeenCalled())

    try {
      fixture.harness.clock.advance(15_000)
      await flushSearch()

      expect((await fixture.read()).slots[0]).toMatchObject({
        state: 'failure',
        rows: [],
        error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: null }
      })
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)
    } finally {
      body.finish(JSON.stringify({ rows: [candidate] }))
      await flushSearch()
    }
    expect((await fixture.read()).slots[0].state).toBe('failure')
  })

  it.each([14_999, 15_000])(
    'timer 실행이 지연돼도 전체 body 완료 시각 %dms로 성공/timeout을 판정한다',
    async (elapsed) => {
      const fixture = await createSearchFixture()
      const body = pendingBody()
      fixture.fetchSearch.mockResolvedValueOnce(body.response)
      await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
      await vi.waitFor(() => expect(body.pull).toHaveBeenCalled())

      fixture.harness.clock.elapseWithoutTimers(elapsed)
      body.finish(JSON.stringify({ rows: [] }))
      await flushSearch()

      const expired = elapsed === 15_000
      expect((await fixture.read()).slots[0]).toMatchObject(
        expired
          ? { state: 'failure', error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: null } }
          : { state: 'empty', error: null }
      )
    }
  )

  it.each(['{broken', JSON.stringify({ rows: [candidate, { ...candidate, fame: '0' }] })])(
    'deadline에 완료된 parsing/전체 후보 검증 실패도 timeout이 우선한다: %s',
    async (text) => {
      const fixture = await createSearchFixture()
      const body = pendingBody()
      fixture.fetchSearch.mockResolvedValueOnce(body.response)
      await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
      await vi.waitFor(() => expect(body.pull).toHaveBeenCalled())

      fixture.harness.clock.elapseWithoutTimers(15_000)
      body.finish(text)
      await flushSearch()

      expect((await fixture.read()).slots[0]).toMatchObject({
        state: 'failure',
        rows: [],
        error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: null }
      })
    }
  )

  it.each([4_999, 5_000])(
    '인증 대기 10초 뒤 body %dms에도 같은 예산을 사용한다',
    async (bodyElapsed) => {
      const fixture = await createSearchFixture()
      fixture.harness.clock.advance(16 * 60_000)
      const refresh = deferred<ReturnType<typeof tokenResponse>>()
      fixture.harness.http.refresh.mockReturnValueOnce(refresh.promise)
      const body = pendingBody()
      fixture.fetchSearch.mockResolvedValueOnce(body.response)
      await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
      await vi.waitFor(() => expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(1))

      fixture.harness.clock.advance(10_000)
      refresh.resolve(
        tokenResponse({
          refreshToken: REFRESH_2,
          accessToken: ACCESS_2,
          accessTokenExpiresAt: '2026-09-06T12:31:00.000Z'
        })
      )
      await vi.waitFor(() => expect(body.pull).toHaveBeenCalled())
      fixture.harness.clock.elapseWithoutTimers(bodyElapsed)
      body.finish(JSON.stringify({ rows: [] }))
      await flushSearch()

      const expired = bodyElapsed === 5_000
      expect((await fixture.read()).slots[0]).toMatchObject(
        expired
          ? { state: 'failure', error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: null } }
          : { state: 'empty', error: null }
      )
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['scheduled', 'late-authorization'])(
    '%s timeout은 검색만 종료하고 공유 refresh·저장·다른 caller를 보존한다',
    async (mode) => {
      const fixture = await createSearchFixture()
      fixture.harness.clock.advance(16 * 60_000)
      const tokens = tokenResponse({
        refreshToken: REFRESH_2,
        accessToken: ACCESS_2,
        accessTokenExpiresAt: '2026-09-06T12:31:00.000Z'
      })
      const refresh = deferred<ReturnType<typeof tokenResponse>>()
      fixture.harness.http.refresh.mockReturnValueOnce(refresh.promise)
      await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
      await vi.waitFor(() => expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(1))
      const ordinary = fixture.auth.authorization()
      const isScheduled = mode === 'scheduled'

      try {
        if (isScheduled) {
          fixture.harness.clock.advance(15_000)
        } else {
          fixture.harness.clock.elapseWithoutTimers(15_000)
          refresh.resolve(tokens)
          await ordinary
        }
        await flushSearch()

        expect((await fixture.read()).slots[0]).toMatchObject({
          state: 'failure',
          error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: null }
        })
        expect(fixture.harness.http.refresh.mock.calls[0][1].aborted).toBe(false)
        expect(fixture.fetchSearch).not.toHaveBeenCalled()
      } finally {
        refresh.resolve(tokens)
        await ordinary
        await flushSearch()
      }

      expect(await ordinary).toMatchObject({ status: 'available', accessToken: ACCESS_2 })
      expect(fixture.harness.store.inspection).toEqual({ status: 'ready', refreshToken: REFRESH_2 })
      expect(fixture.auth.getSnapshot().phase).toBe('signedIn')
      expect(fixture.harness.http.logout).not.toHaveBeenCalled()
      expect(fixture.fetchSearch).not.toHaveBeenCalled()
      expect((await fixture.read()).slots[0].state).toBe('failure')
    }
  )

  it('authorization 대기 중 clear는 해당 waiter만 취소하고 늦은 GET을 만들지 않는다', async () => {
    const fixture = await createSearchFixture()
    fixture.harness.clock.advance(16 * 60_000)
    const refresh = deferred<ReturnType<typeof tokenResponse>>()
    fixture.harness.http.refresh.mockReturnValueOnce(refresh.promise)
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    await vi.waitFor(() => expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(1))
    const ordinary = fixture.auth.authorization()

    await fixture.invoke('controlCharacterSearch', {
      action: 'clear',
      captureId: fixture.captureId,
      slot: 0,
      observationRevision: 2
    })
    expect((await fixture.read()).slots[0]).toMatchObject({ state: 'idle', observationRevision: 2 })
    expect(fixture.harness.http.refresh.mock.calls[0][1].aborted).toBe(false)
    refresh.resolve(
      tokenResponse({
        refreshToken: REFRESH_2,
        accessToken: ACCESS_2,
        accessTokenExpiresAt: '2026-09-06T12:31:00.000Z'
      })
    )
    expect(await ordinary).toMatchObject({ status: 'available', accessToken: ACCESS_2 })
    await flushSearch()

    expect(fixture.fetchSearch).not.toHaveBeenCalled()
    expect((await fixture.read()).slots[0].state).toBe('idle')
  })

  it('같은 nickname의 revision 승격은 기존 request의 15초를 연장하지 않는다', async () => {
    const fixture = await createSearchFixture()
    const response = deferred<Response>()
    fixture.fetchSearch.mockReturnValueOnce(response.promise)
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    await vi.waitFor(() => expect(fixture.fetchSearch).toHaveBeenCalledTimes(1))
    const before = await fixture.read()

    try {
      fixture.harness.clock.advance(10_000)
      await fixture.observe({ slot: 0, observationRevision: 2, nickname: '가나' })
      fixture.harness.clock.advance(5_000)
      await flushSearch()

      expect((await fixture.read()).slots[0]).toMatchObject({
        state: 'failure',
        observationRevision: 2,
        requestId: before.slots[0].requestId,
        error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: null }
      })
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)
    } finally {
      response.resolve(jsonResponse({ body: { rows: [] } }))
      await flushSearch()
    }
  })

  it('사용자 retry는 새 requestId와 새로운 접수 시각의 15초를 사용한다', async () => {
    const fixture = await createSearchFixture()
    fixture.fetchSearch.mockResolvedValueOnce(
      jsonResponse({ status: 500, body: { error: { code: 'INTERNAL_SERVER_ERROR' } } })
    )
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    await vi.waitFor(async () => expect((await fixture.read()).slots[0].state).toBe('failure'))
    const before = await fixture.read()
    const response = deferred<Response>()
    fixture.fetchSearch.mockReturnValueOnce(response.promise)
    fixture.harness.clock.advance(14_000)

    try {
      const retry = await fixture.invoke('controlCharacterSearch', {
        action: 'retry',
        captureId: fixture.captureId,
        slot: 0,
        requestId: before.slots[0].requestId
      })
      expect(retry).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(fixture.fetchSearch).toHaveBeenCalledTimes(2))
      const current = await fixture.read()
      expect(current.slots[0].requestId).not.toBe(before.slots[0].requestId)
      fixture.harness.clock.advance(14_999)
      await flushSearch()
      expect((await fixture.read()).slots[0].state).toBe('pending')
      fixture.harness.clock.advance(1)
      await flushSearch()
      expect((await fixture.read()).slots[0]).toMatchObject({
        state: 'failure',
        error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: null }
      })
    } finally {
      response.resolve(jsonResponse({ body: { rows: [] } }))
      await flushSearch()
    }
  })
})
