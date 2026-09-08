import { describe, expect, it, vi } from 'vitest'
import { ACCESS_1, API_ORIGIN, deferred } from '../auth/auth-test-fixtures'
import { candidate, createSearchFixture, jsonResponse } from './search-test-fixture'

describe('main 검색 관측과 slot 수명', () => {
  it('유효 관측은 pending을 먼저 반환하고 main이 기본 query로 한 번 검색한다', async () => {
    const fixture = await createSearchFixture()
    const response = deferred<Response>()
    fixture.fetchSearch.mockReturnValueOnce(response.promise)

    const admitted = await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })

    expect(admitted).toMatchObject({
      ok: true,
      snapshot: {
        slots: [
          expect.objectContaining({
            state: 'pending',
            observationRevision: 1,
            nickname: '가나',
            requestId: expect.any(String),
            rows: [],
            error: null
          }),
          expect.any(Object),
          expect.any(Object),
          expect.any(Object)
        ]
      }
    })
    await vi.waitFor(() => expect(fixture.fetchSearch).toHaveBeenCalledTimes(1))
    const request = new Request(...fixture.fetchSearch.mock.calls[0])
    const url = new URL(request.url)
    expect(url.origin).toBe(API_ORIGIN)
    expect(url.pathname).toBe('/characters')
    expect([...url.searchParams.entries()]).toEqual([['characterName', '가나']])
    expect(request.method).toBe('GET')
    expect(request.headers.get('authorization')).toBe(`Bearer ${ACCESS_1}`)
    expect(request.credentials).toBe('omit')
    expect(request.redirect).toBe('error')

    response.resolve(jsonResponse({ body: { rows: [candidate] } }))
    await vi.waitFor(async () => {
      expect((await fixture.read()).slots[0]).toMatchObject({ state: 'success', rows: [candidate] })
    })
    expect(fixture.harness.http.refresh).not.toHaveBeenCalled()
  })

  it('다섯 응답 field와 서버 순서를 유지하고 추가 field는 IPC에 보내지 않는다', async () => {
    const fixture = await createSearchFixture()
    const rows = [
      candidate,
      {
        ...candidate,
        characterId: 'unknown-server',
        serverId: 'future',
        serverName: null,
        fame: -1.5
      }
    ]
    fixture.fetchSearch.mockResolvedValueOnce(
      jsonResponse({
        body: { rows: rows.map((row) => ({ ...row, extra: 'discard' })), extra: true }
      })
    )

    const admitted = await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    expect(admitted).toMatchObject({ ok: true })

    await vi.waitFor(async () => {
      expect((await fixture.read()).slots[0]).toMatchObject({ state: 'success', rows, error: null })
    })
    const completed = await fixture.read()
    expect(completed.slots[0].rows).toEqual(rows)
    expect(fixture.published).toHaveBeenLastCalledWith('characterSearchChanged', completed)
  })

  it.each(['', '가', '가나다라마바사아자차카타파', ' 가나', '가나 ', '😀'])(
    '입력 %j는 보정하거나 HTTP로 보내지 않고 재시도 없는 입력 실패로 끝낸다',
    async (nickname) => {
      const fixture = await createSearchFixture()

      const admitted = await fixture.observe({ slot: 0, observationRevision: 1, nickname })

      expect(admitted).toMatchObject({ ok: true })
      const snapshot = await fixture.read()
      expect(snapshot.slots[0]).toMatchObject({
        state: 'failure',
        nickname,
        requestId: expect.any(String),
        rows: [],
        error: { code: 'INVALID_SEARCH_QUERY', retryAfterSeconds: null }
      })
      expect(fixture.fetchSearch).not.toHaveBeenCalled()
      const retry = await fixture.invoke('controlCharacterSearch', {
        action: 'retry',
        captureId: fixture.captureId,
        slot: 0,
        requestId: snapshot.slots[0].requestId
      })
      expect(retry).toMatchObject({ ok: false, error: { code: 'SEARCH_RETRY_NOT_READY' } })
    }
  )

  it('네 slot은 독립적으로 진행하며 역순 완료와 0건을 구분한다', async () => {
    const fixture = await createSearchFixture()
    const responses = [
      deferred<Response>(),
      deferred<Response>(),
      deferred<Response>(),
      deferred<Response>()
    ]
    for (const response of responses) {
      fixture.fetchSearch.mockReturnValueOnce(response.promise)
    }
    for (const slot of [0, 1, 2, 3]) {
      const admitted = await fixture.observe({ slot, observationRevision: 1, nickname: '가나' })
      expect(admitted).toMatchObject({ ok: true })
    }
    await vi.waitFor(() => expect(fixture.fetchSearch).toHaveBeenCalledTimes(4))

    responses[3].resolve(jsonResponse({ body: { rows: [] } }))
    await vi.waitFor(async () => {
      const snapshot = await fixture.read()
      expect(snapshot.slots.map((slot) => slot.state)).toEqual([
        'pending',
        'pending',
        'pending',
        'empty'
      ])
    })
    responses[1].resolve(jsonResponse({ body: { rows: [candidate] } }))
    responses[2].resolve(jsonResponse({ body: { rows: [] } }))
    responses[0].resolve(jsonResponse({ body: { rows: [candidate] } }))

    await vi.waitFor(async () => {
      const snapshot = await fixture.read()
      expect(snapshot.slots.map((slot) => slot.state)).toEqual([
        'success',
        'success',
        'empty',
        'empty'
      ])
    })
  })

  it.each(['pending', 'success', 'failure'])(
    '같은 nickname의 높은 revision은 %s의 request를 유지하고 완료를 막지 않는다',
    async (state) => {
      const fixture = await createSearchFixture()
      const response = deferred<Response>()
      fixture.fetchSearch.mockReturnValueOnce(response.promise)
      const admitted = await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
      expect(admitted).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(fixture.fetchSearch).toHaveBeenCalledTimes(1))
      const isPending = state === 'pending'
      const isFailure = state === 'failure'
      if (!isPending) {
        response.resolve(
          isFailure
            ? jsonResponse({
                status: 500,
                body: { error: { code: 'INTERNAL_SERVER_ERROR', message: 'discard' } }
              })
            : jsonResponse({ body: { rows: [candidate] } })
        )
        await vi.waitFor(async () => expect((await fixture.read()).slots[0].state).toBe(state))
      }
      const before = await fixture.read()

      await fixture.observe({ slot: 0, observationRevision: 3, nickname: '가나' })
      const promoted = await fixture.read()
      expect(promoted.slots[0]).toEqual({ ...before.slots[0], observationRevision: 3 })
      expect(promoted.revision).toBeGreaterThan(before.revision)
      await fixture.observe({ slot: 0, observationRevision: 2, nickname: '다라' })
      await fixture.observe({ slot: 0, observationRevision: 3, nickname: '다라' })
      expect(await fixture.read()).toEqual(promoted)
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)

      if (isPending) {
        response.resolve(jsonResponse({ body: { rows: [candidate] } }))
        await vi.waitFor(async () => {
          expect((await fixture.read()).slots[0]).toMatchObject({
            state: 'success',
            observationRevision: 3,
            requestId: before.slots[0].requestId
          })
        })
      }
    }
  )

  it.each(['success', 'failure'])(
    '새 관측 뒤 이전 요청의 늦은 %s는 현재 slot을 덮지 않는다',
    async (lateState) => {
      const fixture = await createSearchFixture()
      const previous = deferred<Response>()
      fixture.fetchSearch.mockReturnValueOnce(previous.promise)
      expect(
        await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
      ).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(fixture.fetchSearch).toHaveBeenCalledTimes(1))
      const oldRequest = new Request(...fixture.fetchSearch.mock.calls[0])
      const before = await fixture.read()

      expect(
        await fixture.observe({ slot: 0, observationRevision: 2, nickname: '다라' })
      ).toMatchObject({ ok: true })
      await vi.waitFor(async () => expect((await fixture.read()).slots[0].state).toBe('empty'))
      const current = await fixture.read()
      expect(current.slots[0].requestId).not.toBe(before.slots[0].requestId)
      expect(oldRequest.signal.aborted).toBe(true)
      const isFailure = lateState === 'failure'
      if (isFailure) {
        previous.reject(new Error('Synthetic late failure'))
      } else {
        previous.resolve(jsonResponse({ body: { rows: [candidate] } }))
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      expect(await fixture.read()).toEqual(current)
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(2)
    }
  )

  it('clear는 이전 요청을 취소하고 같은 nickname의 다음 관측을 새 검색으로 받는다', async () => {
    const fixture = await createSearchFixture()
    const previous = deferred<Response>()
    fixture.fetchSearch.mockReturnValueOnce(previous.promise)
    expect(
      await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    ).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(fixture.fetchSearch).toHaveBeenCalledTimes(1))
    const before = await fixture.read()
    const oldRequest = new Request(...fixture.fetchSearch.mock.calls[0])

    const cleared = await fixture.invoke('controlCharacterSearch', {
      action: 'clear',
      captureId: fixture.captureId,
      slot: 0,
      observationRevision: 2
    })

    expect(cleared).toMatchObject({ ok: true })
    expect((await fixture.read()).slots[0]).toEqual({
      slot: 0,
      observationRevision: 2,
      requestId: null,
      nickname: null,
      state: 'idle',
      rows: [],
      error: null
    })
    expect(oldRequest.signal.aborted).toBe(true)
    previous.resolve(jsonResponse({ body: { rows: [candidate] } }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect((await fixture.read()).slots[0].state).toBe('idle')

    await fixture.observe({ slot: 0, observationRevision: 3, nickname: '가나' })
    await vi.waitFor(async () => expect((await fixture.read()).slots[0].state).toBe('empty'))
    expect((await fixture.read()).slots[0].requestId).not.toBe(before.slots[0].requestId)
    expect(fixture.fetchSearch).toHaveBeenCalledTimes(2)
  })
})
