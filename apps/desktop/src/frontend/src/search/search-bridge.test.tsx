// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type {
  SearchApi,
  SearchCommandResult,
  SearchSlot,
  SearchSnapshot
} from '../../../preload/common/types/search'
import {
  CAPTURE_ID,
  searchRow,
  searchSlot,
  searchSnapshot,
  withSearchSlot,
  invalidSearchSnapshots
} from '../../../preload/api/search-test-fixture'
import { CaptureSearch } from './capture-search'
import { authSnapshot, createRendererFixture, media } from './search-renderer-test-fixture'

type Fixture = ReturnType<typeof createRendererFixture>
function state(fixture: Fixture, slot: SearchSlot, revision?: number): SearchSnapshot {
  return {
    ...withSearchSlot(slot),
    captureId: CAPTURE_ID,
    revision: revision ?? fixture.current().revision + 1
  }
}
async function recognizedFixture(): Promise<Fixture> {
  const fixture = createRendererFixture()
  await fixture.mount()
  await fixture.start()
  media.crops.mockReturnValue([document.createElement('canvas'), null, null, null])
  await fixture.cycle(2)
  return fixture
}

it('검색 event를 먼저 구독한 뒤 read하고 unmount에서 해당 구독을 해제한다', async () => {
  const fixture = createRendererFixture()
  await fixture.mount()
  expect(fixture.order.slice(0, 2)).toEqual(['subscribe', 'read'])
  expect(fixture.search.onCharacterSearchChanged).toHaveBeenCalledOnce()
  await fixture.unmount()
  expect(fixture.order.at(-1)).toBe('unsubscribe')
})

it('read 응답 전 event가 있어도 reload에서 기존 capture를 재개하거나 후보를 표시하지 않는다', async () => {
  const fixture = createRendererFixture()
  const read = Promise.withResolvers<SearchCommandResult>()
  fixture.search.controlCharacterSearch.mockReturnValueOnce(read.promise)
  await fixture.mount()
  expect(fixture.search.controlCharacterSearch).toHaveBeenCalledWith({ action: 'read' })
  const existing = withSearchSlot(searchSlot({ state: 'success', rows: [searchRow] }))
  await fixture.emit({ ...existing, revision: 8 })
  read.resolve({ ok: true, snapshot: { ...existing, revision: 7 } })
  await act(async () => undefined)
  expect(fixture.container.textContent).not.toContain(searchRow.characterId)
  expect(fixture.getDisplayMedia).not.toHaveBeenCalled()
  expect(fixture.button('Start').disabled).toBe(true)
})

it('같은 run의 오래된·중복 event는 최신 성공을 덮지 않는다', async () => {
  const fixture = await recognizedFixture()
  const latest = state(fixture, searchSlot({ state: 'success', rows: [searchRow] }), 10)
  await fixture.emit(latest)
  expect(fixture.container.textContent).toContain(searchRow.characterId)
  const stale = state(
    fixture,
    searchSlot({ state: 'failure', error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: null } }),
    9
  )
  await fixture.emit(stale)
  await fixture.emit({ ...stale, revision: 10 })
  expect(fixture.container.textContent).toContain(searchRow.characterId)
  expect(fixture.container.textContent).not.toContain('검색 시간이 초과')
})

it('다른 capture ID와 현재 관측보다 오래된 slot은 새 event revision에서도 표시하지 않는다', async () => {
  const fixture = await recognizedFixture()
  const response = state(fixture, searchSlot({ state: 'success', rows: [searchRow] }))
  await fixture.emit({ ...response, captureId: '00000000-0000-4000-8000-000000000099' })
  expect(fixture.container.textContent).not.toContain(searchRow.characterId)
  fixture.resources.worker.recognize.mockResolvedValue({ data: { text: 'BOB' } })
  await fixture.cycle(2)
  await fixture.emit({ ...response, revision: 20 })
  expect(fixture.container.textContent).not.toContain(searchRow.characterId)
  expect(fixture.search.controlCharacterSearch).toHaveBeenCalledWith({
    action: 'clear',
    captureId: CAPTURE_ID,
    slot: 0,
    observationRevision: 2
  })
})

it('capture null은 표시를 지우고 이후 옛 capture event가 같은 화면을 복구하지 않는다', async () => {
  const fixture = await recognizedFixture()
  const complete = state(fixture, searchSlot({ state: 'success', rows: [searchRow] }), 10)
  await fixture.emit(complete)
  expect(fixture.container.textContent).toContain(searchRow.characterId)
  await fixture.emit(searchSnapshot({ captureId: null, revision: 11 }))
  expect(fixture.container.textContent).not.toContain(searchRow.characterId)
  await fixture.emit({ ...complete, revision: 12 })
  expect(fixture.container.textContent).not.toContain(searchRow.characterId)
})

it.each(['clear', 'new observation'] as const)(
  'local %s는 IPC 완료와 event를 기다리지 않고 옛 표시를 지운다',
  async (transition) => {
    const fixture = await recognizedFixture()
    await fixture.emit(state(fixture, searchSlot({ state: 'success', rows: [searchRow] })))
    expect(fixture.container.textContent).toContain(searchRow.characterId)
    const clear = Promise.withResolvers<SearchCommandResult>()
    fixture.search.controlCharacterSearch.mockReturnValueOnce(clear.promise)
    fixture.resources.worker.recognize.mockResolvedValue({ data: { text: 'BOB' } })
    await fixture.cycle()
    expect(fixture.container.textContent).not.toContain(searchRow.characterId)
    const isNewObservation = transition === 'new observation'
    if (isNewObservation) {
      fixture.capture.notifyStableNicknameDetected.mockReturnValueOnce(new Promise(() => undefined))
      await fixture.cycle()
    }
    await fixture.emit(state(fixture, searchSlot({ state: 'success', rows: [searchRow] }), 30))
    expect(fixture.container.textContent).not.toContain(searchRow.characterId)
    clear.resolve({ ok: true, snapshot: searchSnapshot({ revision: 31 }) })
    await act(async () => undefined)
  }
)

it('notify 응답 유실은 read로만 확인하며 같은 OCR 통지를 자동 재전송하지 않는다', async () => {
  const fixture = createRendererFixture()
  await fixture.mount()
  await fixture.start()
  const completed = state(
    fixture,
    searchSlot({ nickname: 'ALICE', state: 'success', rows: [searchRow] }),
    10
  )
  fixture.capture.notifyStableNicknameDetected.mockRejectedValueOnce(
    new Error('Synthetic IPC loss')
  )
  fixture.search.controlCharacterSearch.mockResolvedValueOnce({ ok: true, snapshot: completed })
  const beforeReads = fixture.search.controlCharacterSearch.mock.calls.length
  media.crops.mockReturnValue([document.createElement('canvas'), null, null, null])
  await fixture.cycle(4)
  expect(fixture.search.controlCharacterSearch.mock.calls.slice(beforeReads)).toEqual([
    [{ action: 'read' }]
  ])
  expect(fixture.capture.notifyStableNicknameDetected).toHaveBeenCalledOnce()
  expect(fixture.container.textContent).toContain(searchRow.characterId)
})

it('초기 read 실패는 검색 연결 안내를 표시하고 command를 자동 재전송하지 않는다', async () => {
  const fixture = createRendererFixture()
  fixture.search.controlCharacterSearch.mockRejectedValueOnce(new Error('Synthetic IPC failure'))
  await fixture.mount()
  expect(fixture.search.controlCharacterSearch).toHaveBeenCalledExactlyOnceWith({ action: 'read' })
  expect(fixture.container.textContent).toContain('검색 연결을 확인할 수 없습니다')
  expect(fixture.getDisplayMedia).not.toHaveBeenCalled()
})

it('검색 run 변경은 구독·표시를 버리고 auth 재동기화와 새 read를 수행한다', async () => {
  const fixture = await recognizedFixture()
  await fixture.emit(state(fixture, searchSlot({ state: 'success', rows: [searchRow] }), 10))
  const callback = fixture.search.onCharacterSearchChanged.mock.calls[0]?.[0]
  const authReads = fixture.auth.getAuthState.mock.calls.length
  const previousSubscriptions = fixture.search.onCharacterSearchChanged.mock.calls.length
  const nextRun = searchSnapshot({
    runId: '00000000-0000-4000-8000-000000000099',
    captureId: null,
    revision: 0
  })
  await fixture.emit(nextRun)
  expect(fixture.container.textContent).not.toContain(searchRow.characterId)
  expect(fixture.auth.getAuthState.mock.calls.length).toBeGreaterThan(authReads)
  expect(fixture.search.onCharacterSearchChanged.mock.calls.length).toBeGreaterThan(
    previousSubscriptions
  )
  expect(fixture.search.controlCharacterSearch).toHaveBeenLastCalledWith({ action: 'read' })
  expect(fixture.order).toContain('unsubscribe')
  await act(async () =>
    callback?.(state(fixture, searchSlot({ state: 'success', rows: [searchRow] }), 99))
  )
  expect(fixture.container.textContent).not.toContain(searchRow.characterId)
})

it.each(invalidSearchSnapshots)(
  'renderer도 %s event를 표시 상태로 수용하지 않는다',
  async (_name, invalid) => {
    const fixture = await recognizedFixture()
    await fixture.emit(state(fixture, searchSlot({ state: 'success', rows: [searchRow] }), 10))
    expect(fixture.container.textContent).toContain(searchRow.characterId)
    const malformed = invalid() as SearchSnapshot
    const isSafeRevision = Number.isSafeInteger(malformed.revision)
    if (isSafeRevision) {
      const isNonnegativeRevision = malformed.revision >= 0
      if (isNonnegativeRevision) {
        await fixture.emit({ ...malformed, revision: 99 })
      } else {
        await fixture.emit(malformed)
      }
    } else {
      await fixture.emit(malformed)
    }
    expect(fixture.container.textContent).toContain(searchRow.characterId)
  }
)

it('새 success event 뒤 늦은 notify invoke의 pending snapshot은 표시를 되돌리지 않는다', async () => {
  const fixture = createRendererFixture()
  await fixture.mount()
  await fixture.start()
  const acknowledgment = Promise.withResolvers<SearchCommandResult>()
  fixture.capture.notifyStableNicknameDetected.mockReturnValueOnce(acknowledgment.promise)
  media.crops.mockReturnValue([document.createElement('canvas'), null, null, null])
  await fixture.cycle(2)
  await fixture.emit(state(fixture, searchSlot({ state: 'success', rows: [searchRow] }), 10))
  expect(fixture.container.textContent).toContain(searchRow.characterId)
  acknowledgment.resolve({ ok: true, snapshot: state(fixture, searchSlot(), 9) })
  await act(async () => undefined)
  expect(fixture.container.textContent).toContain(searchRow.characterId)
  expect(fixture.container.textContent).not.toContain('검색 중')
})

it('clear 응답 유실은 read만 수행하며 조회가 옛 관측이면 지운 후보를 복구하지 않는다', async () => {
  const fixture = await recognizedFixture()
  const previous = state(fixture, searchSlot({ state: 'success', rows: [searchRow] }), 10)
  await fixture.emit(previous)
  expect(fixture.container.textContent).toContain(searchRow.characterId)
  fixture.search.controlCharacterSearch
    .mockRejectedValueOnce(new Error('Synthetic clear response loss'))
    .mockResolvedValueOnce({ ok: true, snapshot: { ...previous, revision: 11 } })
  const before = fixture.search.controlCharacterSearch.mock.calls.length
  media.crops.mockReturnValue([null, null, null, null])
  await fixture.cycle(3)
  expect(fixture.search.controlCharacterSearch.mock.calls.slice(before)).toEqual([
    [{ action: 'clear', captureId: CAPTURE_ID, slot: 0, observationRevision: 2 }],
    [{ action: 'read' }]
  ])
  expect(fixture.container.textContent).not.toContain(searchRow.characterId)
})

it('begin 응답 유실은 read로 확인하고 같은 Start 명령을 자동 재전송하지 않는다', async () => {
  const fixture = createRendererFixture()
  await fixture.mount()
  fixture.search.controlCharacterSearch
    .mockRejectedValueOnce(new Error('Synthetic begin response loss'))
    .mockResolvedValueOnce({ ok: true, snapshot: searchSnapshot() })
  const before = fixture.search.controlCharacterSearch.mock.calls.length
  await fixture.start()
  const commands = fixture.search.controlCharacterSearch.mock.calls
    .slice(before)
    .map(([command]) => command.action)
  expect(commands.slice(0, 2)).toEqual(['begin', 'read'])
  expect(
    commands.filter((action) => {
      const isBegin = action === 'begin'
      return isBegin
    })
  ).toHaveLength(1)
})

it('초기 read 실패 뒤 먼저 보류한 event만으로 연결 실패를 지우지 않는다', async () => {
  const fixture = createRendererFixture()
  const read = Promise.withResolvers<SearchCommandResult>()
  fixture.search.controlCharacterSearch.mockReturnValueOnce(read.promise)
  await fixture.mount()
  await fixture.emit(searchSnapshot({ captureId: null, revision: 1 }))
  read.reject(new Error('Synthetic initial read loss'))
  await act(async () => undefined)
  expect(fixture.container.textContent).toContain('검색 연결을 확인할 수 없습니다')
  expect(fixture.search.controlCharacterSearch).toHaveBeenCalledExactlyOnceWith({ action: 'read' })
})

it.each(['buffered', 'late'] as const)(
  '초기 read 실패 후 %s event가 와도 source 선택과 Start로 검색·media·OCR를 시작하지 않는다',
  async (eventTiming) => {
    const fixture = createRendererFixture()
    const read = Promise.withResolvers<SearchCommandResult>()
    fixture.search.controlCharacterSearch.mockReturnValueOnce(read.promise)
    await fixture.mount()
    const isBuffered = eventTiming === 'buffered'
    if (isBuffered) {
      await fixture.emit(searchSnapshot({ captureId: null, revision: 1 }))
    }
    read.reject(new Error('Synthetic initial read failure'))
    await act(async () => undefined)
    if (!isBuffered) {
      await fixture.emit(searchSnapshot({ captureId: null, revision: 1 }))
    }
    expect(fixture.container.textContent).toContain('검색 연결을 확인할 수 없습니다')

    await fixture.select()
    await fixture.click('Start')
    await fixture.emit(searchSnapshot({ captureId: null, revision: 2 }))

    expect(fixture.search.controlCharacterSearch).toHaveBeenCalledExactlyOnceWith({
      action: 'read'
    })
    expect(fixture.getDisplayMedia).not.toHaveBeenCalled()
    expect(media.worker).not.toHaveBeenCalled()
    expect(media.loop).not.toHaveBeenCalled()
    expect(fixture.container.textContent).toContain('검색 연결을 확인할 수 없습니다')
  }
)

it.each(['pending', 'failed'] as const)(
  '상태 동기화가 %s이면 CaptureSearch.begin 직접 호출도 main begin을 보내지 않는다',
  async (readState) => {
    const read = Promise.withResolvers<SearchCommandResult>()
    const control = vi
      .fn<SearchApi['controlCharacterSearch']>()
      .mockImplementation(async (command) => {
        const isRead = command.action === 'read'
        if (isRead) {
          return read.promise
        }
        return { ok: true, snapshot: searchSnapshot() }
      })
    const bridge = new CaptureSearch({
      api: { controlCharacterSearch: control, onCharacterSearchChanged: () => () => {} },
      notify: vi.fn(),
      onChange: vi.fn(),
      onInvalidated: vi.fn(),
      resynchronizeAuth: vi.fn()
    })
    bridge.connect()
    const isFailed = readState === 'failed'
    if (isFailed) {
      read.reject(new Error('Synthetic initial read failure'))
      await act(async () => undefined)
    }
    try {
      const captureId = await bridge.begin({
        auth: authSnapshot(),
        signal: new AbortController().signal
      })
      expect(control).toHaveBeenCalledExactlyOnceWith({ action: 'read' })
      expect(captureId).toBeNull()
    } finally {
      bridge.dispose()
    }
  }
)
