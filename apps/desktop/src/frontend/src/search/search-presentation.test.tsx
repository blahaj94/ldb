// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import {
  SEARCH_ERRORS,
  type SearchCommandResult,
  type SearchErrorCode,
  type SearchSlot
} from '../../../preload/common/types/search'
import {
  CAPTURE_ID,
  REQUEST_ID,
  searchRow,
  searchSlot,
  withSearchSlot
} from '../../../preload/api/search-test-fixture'
import { authSnapshot, createRendererFixture, media } from './search-renderer-test-fixture'

type Fixture = ReturnType<typeof createRendererFixture>
async function recognized(): Promise<Fixture> {
  const fixture = createRendererFixture()
  await fixture.mount()
  await fixture.start()
  const crop = document.createElement('canvas')
  media.crops.mockReturnValue([crop, crop, crop, crop])
  await fixture.cycle(2)
  return fixture
}
function region(fixture: Fixture, slot = 0): HTMLElement {
  const view = fixture.container.querySelector(`[aria-label="슬롯 ${slot + 1} 검색"]`)
  expect(view, `슬롯 ${slot + 1} 검색의 접근 가능한 영역`).not.toBeNull()
  return view as HTMLElement
}
async function emitSlot(fixture: Fixture, slot: SearchSlot): Promise<void> {
  await fixture.emit({ ...withSearchSlot(slot), revision: fixture.current().revision + 1 })
}

it('네 slot은 pending·후보·0건·실패를 독립 표시하고 모든 후보 field와 서버 순서를 보존한다', async () => {
  const fixture = await recognized()
  const second = {
    ...searchRow,
    characterId: 'second-character',
    characterName: '두번째',
    serverId: 'unknown',
    serverName: null,
    fame: null
  }
  const slots: SearchSlot[] = [
    searchSlot({ slot: 0 }),
    searchSlot({ slot: 1, state: 'success', rows: [searchRow, second] }),
    searchSlot({ slot: 2, state: 'empty' }),
    searchSlot({
      slot: 3,
      state: 'failure',
      error: { code: 'SEARCH_AUTH_NOT_READY', retryAfterSeconds: null }
    })
  ]
  await fixture.emit({ ...fixture.current(), captureId: CAPTURE_ID, revision: 10, slots })
  expect(region(fixture, 0).textContent).toContain('검색 중')
  expect(region(fixture, 0).getAttribute('aria-busy')).toBe('true')
  expect(region(fixture, 0).querySelector('[role="status"]')).not.toBeNull()
  const candidates = region(fixture, 1)
  for (const field of [
    searchRow.characterId,
    searchRow.characterName,
    searchRow.serverId,
    searchRow.serverName
  ]) {
    expect(candidates.textContent).toContain(field)
  }
  expect(candidates.textContent).toContain('0')
  expect(candidates.textContent!.indexOf(searchRow.characterId)).toBeLessThan(
    candidates.textContent!.indexOf(second.characterId)
  )
  expect(candidates.querySelector('b')).toBeNull()
  expect(candidates.textContent).not.toContain('undefined')
  expect(region(fixture, 2).textContent).toContain('검색 결과가 없습니다.')
  expect(region(fixture, 3).textContent).toContain(SEARCH_ERRORS.SEARCH_AUTH_NOT_READY.message)
  expect(region(fixture, 3).textContent).not.toContain('검색 결과가 없습니다.')
  expect(fixture.button('다시 시도', region(fixture, 3)).disabled).toBe(false)
})

const failures = (Object.keys(SEARCH_ERRORS) as SearchErrorCode[]).filter((code) => {
  const isPublishedFailure = code !== 'AUTHENTICATION_REQUIRED'
  return isPublishedFailure
})
it.each(failures)('%s는 고정 한국어 안내와 허용된 수동 retry만 제공한다', async (code) => {
  const fixture = await recognized()
  await emitSlot(
    fixture,
    searchSlot({ state: 'failure', error: { code, retryAfterSeconds: null } })
  )
  const view = region(fixture)
  expect(view.textContent).toContain(SEARCH_ERRORS[code].message)
  expect(view.textContent).not.toContain('검색 결과가 없습니다.')
  const canRetry = SEARCH_ERRORS[code].retryable
  if (canRetry) {
    const retry = fixture.button('다시 시도', view)
    expect(retry.disabled).toBe(false)
    await act(async () => retry.click())
    expect(fixture.search.controlCharacterSearch).toHaveBeenLastCalledWith({
      action: 'retry',
      captureId: CAPTURE_ID,
      slot: 0,
      requestId: REQUEST_ID
    })
  } else {
    expect(view.querySelector('button')).toBeNull()
  }
})

it('429 유효 대기 동안 retry를 막고 같은 failure의 0초 event에서는 버튼만 활성화한다', async () => {
  const fixture = await recognized()
  const failure = searchSlot({
    state: 'failure',
    error: { code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: 2 }
  })
  await emitSlot(fixture, failure)
  const before = fixture.search.controlCharacterSearch.mock.calls.length
  const retry = fixture.button('다시 시도', region(fixture))
  expect(retry.disabled).toBe(true)
  await act(async () => retry.click())
  expect(fixture.search.controlCharacterSearch.mock.calls.length).toBe(before)
  await emitSlot(fixture, {
    ...failure,
    error: { code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: 0 }
  })
  expect(fixture.search.controlCharacterSearch.mock.calls.length).toBe(before)
  expect(fixture.button('다시 시도', region(fixture)).disabled).toBe(false)
  expect(region(fixture).textContent).toContain(SEARCH_ERRORS.SEARCH_RATE_LIMITED.message)
  await act(async () => fixture.button('다시 시도', region(fixture)).click())
  expect(fixture.search.controlCharacterSearch).toHaveBeenLastCalledWith({
    action: 'retry',
    captureId: CAPTURE_ID,
    slot: 0,
    requestId: REQUEST_ID
  })
})

it('retry 응답을 기다리는 동안 버튼을 비활성화하고 같은 요청을 중복 전송하지 않는다', async () => {
  const fixture = await recognized()
  await emitSlot(
    fixture,
    searchSlot({ state: 'failure', error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: null } })
  )
  const pending = Promise.withResolvers<SearchCommandResult>()
  fixture.search.controlCharacterSearch.mockReturnValueOnce(pending.promise)
  const before = fixture.search.controlCharacterSearch.mock.calls.length
  await act(async () => fixture.button('다시 시도', region(fixture)).click())
  expect(fixture.button('다시 시도', region(fixture)).disabled).toBe(true)
  await act(async () => fixture.button('다시 시도', region(fixture)).click())
  expect(fixture.search.controlCharacterSearch.mock.calls.length).toBe(before + 1)
  const next = searchSlot({ requestId: '00000000-0000-4000-8000-000000000099' })
  pending.resolve({ ok: true, snapshot: { ...withSearchSlot(next), revision: 30 } })
  await act(async () => undefined)
  expect(region(fixture).textContent).toContain('검색 중')
  expect(region(fixture).textContent).not.toContain(SEARCH_ERRORS.SEARCH_TIMEOUT.message)
})

it('retry 응답 유실은 read로 재동기화하고 retry를 자동 재전송하지 않는다', async () => {
  const fixture = await recognized()
  await emitSlot(
    fixture,
    searchSlot({ state: 'failure', error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: null } })
  )
  const next = withSearchSlot(searchSlot({ requestId: '00000000-0000-4000-8000-000000000099' }))
  fixture.search.controlCharacterSearch
    .mockRejectedValueOnce(new Error('Synthetic retry response loss'))
    .mockResolvedValueOnce({ ok: true, snapshot: { ...next, revision: 30 } })
  const before = fixture.search.controlCharacterSearch.mock.calls.length
  await act(async () => fixture.button('다시 시도', region(fixture)).click())
  expect(fixture.search.controlCharacterSearch.mock.calls.slice(before)).toEqual([
    [{ action: 'retry', captureId: CAPTURE_ID, slot: 0, requestId: REQUEST_ID }],
    [{ action: 'read' }]
  ])
  expect(region(fixture).textContent).toContain('검색 중')
})

it.each(['Stop', 'source', 'auth', 'unmount'] as const)(
  '%s는 main 응답 없이 현재 후보를 즉시 지운다',
  async (transition) => {
    const fixture = await recognized()
    await emitSlot(fixture, searchSlot({ state: 'success', rows: [searchRow] }))
    expect(fixture.container.textContent).toContain(searchRow.characterId)
    fixture.search.controlCharacterSearch.mockReturnValue(new Promise(() => undefined))
    const isStop = transition === 'Stop'
    const isSource = transition === 'source'
    const isAuth = transition === 'auth'
    if (isStop) {
      await fixture.click('Stop')
    } else if (isSource) {
      await fixture.select('next')
    } else if (isAuth) {
      await fixture.emitAuth(authSnapshot(2, false))
    } else {
      await fixture.unmount()
    }
    expect(fixture.container.textContent).not.toContain(searchRow.characterId)
  }
)

it('한 slot의 retry 응답 대기는 다른 slot의 사용자 retry를 막지 않는다', async () => {
  const fixture = await recognized()
  const secondId = '00000000-0000-4000-8000-000000000099'
  const error = { code: 'SEARCH_TIMEOUT' as const, retryAfterSeconds: null }
  const slots = fixture.current().slots.map((slot) => {
    const isFailure = slot.slot < 2
    const isFirst = slot.slot === 0
    return isFailure
      ? searchSlot({
          slot: slot.slot,
          state: 'failure',
          requestId: isFirst ? REQUEST_ID : secondId,
          error
        })
      : slot
  })
  await fixture.emit({ ...fixture.current(), captureId: CAPTURE_ID, revision: 10, slots })
  fixture.search.controlCharacterSearch.mockReturnValue(new Promise(() => undefined))
  const before = fixture.search.controlCharacterSearch.mock.calls.length
  await act(async () => fixture.button('다시 시도', region(fixture, 0)).click())
  expect(fixture.button('다시 시도', region(fixture, 0)).disabled).toBe(true)
  expect(fixture.button('다시 시도', region(fixture, 1)).disabled).toBe(false)
  await act(async () => fixture.button('다시 시도', region(fixture, 1)).click())
  expect(fixture.search.controlCharacterSearch.mock.calls.slice(before)).toEqual([
    [{ action: 'retry', captureId: CAPTURE_ID, slot: 0, requestId: REQUEST_ID }],
    [{ action: 'retry', captureId: CAPTURE_ID, slot: 1, requestId: secondId }]
  ])
})
