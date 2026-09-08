import { expect, it, vi } from 'vitest'
import { deferred } from '../auth/auth-test-fixtures'
import { candidate, createSearchFixture, jsonResponse } from './search-test-fixture'

it.each(['navigation', 'destruction', 'render-process-gone'] as const)(
  '%s callback은 pending 요청을 즉시 종료하고 같은 URL의 새 capture에 늦은 성공·실패를 보내지 않는다',
  async (transition) => {
    const fixture = await createSearchFixture()
    const oldSuccess = deferred<Response>()
    const oldFailure = deferred<Response>()
    fixture.fetchSearch
      .mockReturnValueOnce(oldSuccess.promise)
      .mockReturnValueOnce(oldFailure.promise)
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    await fixture.observe({ slot: 1, observationRevision: 1, nickname: '다라' })
    await vi.waitFor(() => expect(fixture.fetchSearch).toHaveBeenCalledTimes(2))
    const requests = fixture.fetchSearch.mock.calls.map((args) => new Request(...args))

    const isNavigation = transition === 'navigation'
    if (isNavigation) {
      fixture.documentEvents.emit(
        'did-start-navigation',
        {},
        'file:///search-fixture/index.html',
        false,
        true
      )
    } else {
      const eventName = transition === 'destruction' ? 'destroyed' : 'render-process-gone'
      fixture.documentEvents.emit(eventName, {}, { reason: 'crashed' })
    }

    expect(requests.map((request) => request.signal.aborted)).toEqual([true, true])
    expect((await fixture.read()).captureId).toBeNull()
    fixture.replaceDocument()
    await fixture.invoke('selectCaptureSource', 'window:search-fixture')
    const auth = fixture.auth.getSnapshot()
    await fixture.invoke('controlCharacterSearch', {
      action: 'begin',
      authRunId: auth.runId,
      authRevision: auth.revision
    })
    const current = await fixture.read()
    expect(current.captureId).not.toBe(fixture.captureId)
    expect(current.captureId).not.toBeNull()
    fixture.published.mockClear()

    oldSuccess.resolve(jsonResponse({ body: { rows: [candidate] } }))
    oldFailure.resolve(
      jsonResponse({
        status: 500,
        body: { error: { code: 'INTERNAL_SERVER_ERROR' } }
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await fixture.read()).toEqual(current)
    expect(fixture.published).not.toHaveBeenCalled()
  }
)
