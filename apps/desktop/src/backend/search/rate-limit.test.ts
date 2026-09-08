import { describe, expect, it, vi } from 'vitest'
import type { SearchSlot } from '../../preload/common/types/search'
import { createSearchFixture, jsonResponse } from './search-test-fixture'

type Fixture = Awaited<ReturnType<typeof createSearchFixture>>

async function limited(fixture: Fixture, retryAfter?: string): Promise<SearchSlot> {
  const headers: Record<string, string> = {}
  const hasRetryAfter = retryAfter != null
  if (hasRetryAfter) {
    headers['Retry-After'] = retryAfter
  }
  fixture.fetchSearch.mockResolvedValueOnce(
    jsonResponse({
      status: 429,
      headers,
      body: { error: { code: 'SEARCH_RATE_LIMITED', message: 'discard' } }
    })
  )
  await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
  await vi.waitFor(async () => expect((await fixture.read()).slots[0].state).not.toBe('pending'))
  const slot = (await fixture.read()).slots[0]
  expect(slot).toMatchObject({ state: 'failure', rows: [], error: { code: 'SEARCH_RATE_LIMITED' } })
  expect(slot.requestId).toEqual(expect.any(String))
  return slot
}

function retry(fixture: Fixture, slot: SearchSlot): Promise<unknown> {
  return fixture.invoke('controlCharacterSearch', {
    action: 'retry',
    captureId: fixture.captureId,
    slot: slot.slot,
    requestId: slot.requestId
  })
}

async function flushSearch(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('main의 429 Retry-After와 사용자 재시도', () => {
  it('body 검증에 걸린 시간을 더하지 않고 headers 수신 시각부터 Retry-After를 지킨다', async () => {
    const fixture = await createSearchFixture()
    const pull = vi.fn()
    let finish!: () => void
    let bodyFinished = false
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          finish = () => {
            if (bodyFinished) {
              return
            }
            bodyFinished = true
            const text = JSON.stringify({ error: { code: 'SEARCH_RATE_LIMITED' } })
            controller.enqueue(new TextEncoder().encode(text))
            controller.close()
          }
        },
        pull
      },
      { highWaterMark: 0 }
    )
    fixture.fetchSearch.mockResolvedValueOnce(
      new Response(body, { status: 429, headers: { 'Retry-After': '2' } })
    )
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })

    try {
      await vi.waitFor(() => expect(pull).toHaveBeenCalled())
      fixture.harness.clock.advance(1_000)
      finish()
      await vi.waitFor(async () => expect((await fixture.read()).slots[0].state).toBe('failure'))
      const failed = (await fixture.read()).slots[0]
      expect(failed.error).toEqual({ code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: 2 })
      fixture.harness.clock.advance(999)
      expect(await retry(fixture, failed)).toMatchObject({
        ok: false,
        error: { code: 'SEARCH_RETRY_NOT_READY' }
      })
      fixture.harness.clock.advance(1)
      await flushSearch()

      expect((await fixture.read()).slots[0]).toEqual({
        ...failed,
        error: { code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: 0 }
      })
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)
    } finally {
      finish()
    }
  })

  it.each(['2', '0002'])(
    '유효한 %s초는 만료 전 retry를 거절하고 같은 실패의 버튼만 활성화한다',
    async (header) => {
      const fixture = await createSearchFixture()
      const failed = await limited(fixture, header)
      expect(failed.error).toEqual({ code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: 2 })
      expect(await retry(fixture, failed)).toMatchObject({
        ok: false,
        error: { code: 'SEARCH_RETRY_NOT_READY' }
      })

      fixture.harness.clock.advance(1_999)
      await flushSearch()
      expect(await retry(fixture, failed)).toMatchObject({
        ok: false,
        error: { code: 'SEARCH_RETRY_NOT_READY' }
      })
      const waiting = await fixture.read()
      fixture.harness.clock.advance(1)
      await flushSearch()
      const expired = await fixture.read()

      expect(expired.slots[0]).toEqual({
        ...failed,
        error: { code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: 0 }
      })
      expect(expired.revision).toBeGreaterThan(waiting.revision)
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)
      expect(fixture.published).toHaveBeenLastCalledWith('characterSearchChanged', expired)
      expect(await retry(fixture, failed)).toMatchObject({ ok: true })
      await vi.waitFor(async () => expect((await fixture.read()).slots[0].state).toBe('empty'))
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(2)
      expect((await fixture.read()).slots[0].requestId).not.toBe(failed.requestId)
    }
  )

  it.each([
    undefined,
    '',
    '0',
    '-1',
    '+1',
    '1.5',
    '1e2',
    '1 2',
    'Tue, 08 Sep 2026 00:00:00 GMT',
    '9007199254740992'
  ])(
    '누락/invalid Retry-After %j는 null이고 임의 대기 없이 수동 retry를 허용한다',
    async (header) => {
      const fixture = await createSearchFixture()
      const failed = await limited(fixture, header)

      expect(failed.error).toEqual({ code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: null })
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)
      expect(await retry(fixture, failed)).toMatchObject({ ok: true })
      await vi.waitFor(async () => expect((await fixture.read()).slots[0].state).toBe('empty'))
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(2)
    }
  )

  it('큰 safe integer 초는 Node timer 상한 때문에 즉시 만료되지 않는다', async () => {
    const fixture = await createSearchFixture()
    const schedule = fixture.harness.clock.schedule.bind(fixture.harness.clock)
    // Node의 2^31-1ms 초과 delay가 1ms로 바뀌는 경계를 clock effect에서 모사한다.
    vi.spyOn(fixture.harness.clock, 'schedule').mockImplementation((delay, callback) => {
      const exceedsTimerRange = delay > 2_147_483_647
      const nativeDelay = exceedsTimerRange ? 1 : delay
      return schedule(nativeDelay, callback)
    })
    const failed = await limited(fixture, String(Number.MAX_SAFE_INTEGER))

    fixture.harness.clock.advance(1)
    await flushSearch()

    expect((await fixture.read()).slots[0]).toEqual({
      ...failed,
      error: { code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: Number.MAX_SAFE_INTEGER }
    })
    expect(await retry(fixture, failed)).toMatchObject({
      ok: false,
      error: { code: 'SEARCH_RETRY_NOT_READY' }
    })
    expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)
  })

  it.each(['source-clear', 'new-observation'])(
    '%s는 이전 429 timer를 폐기하고 만료 때 현재 상태나 HTTP를 바꾸지 않는다',
    async (action) => {
      const fixture = await createSearchFixture()
      await limited(fixture, '2')
      const isSourceClear = action === 'source-clear'

      if (isSourceClear) {
        await fixture.invoke('selectCaptureSource', '')
      } else {
        await fixture.observe({ slot: 0, observationRevision: 2, nickname: '다라' })
        await vi.waitFor(async () => expect((await fixture.read()).slots[0].state).toBe('empty'))
      }
      const before = await fixture.read()
      const publishedBefore = fixture.published.mock.calls.length
      const hasPendingTimer = fixture.harness.clock.scheduled.some((task) => {
        const isFuture = task.at > fixture.harness.clock.monotonicMs
        const isActive = !task.cancelled && isFuture
        return isActive
      })
      expect(hasPendingTimer).toBe(false)

      fixture.harness.clock.advance(2_000)
      await flushSearch()

      expect(await fixture.read()).toEqual(before)
      expect(fixture.published).toHaveBeenCalledTimes(publishedBefore)
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(isSourceClear ? 1 : 2)
    }
  )
})
