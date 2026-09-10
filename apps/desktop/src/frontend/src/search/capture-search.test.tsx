// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { SearchApi, SearchCommandResult } from '../../../preload/common/types/search'
import { CAPTURE_ID, searchSnapshot, SEARCH_RUN } from '../../../preload/api/search-test-fixture'
import { CaptureSearch } from './capture-search'
import {
  authSnapshot,
  captureResources,
  createRendererFixture,
  media
} from './search-renderer-test-fixture'

it('begin은 snapshot 비교와 signal을 원본 순서로 읽고 latest-only captureId도 읽는다', async () => {
  const events: string[] = []
  const latest = searchSnapshot({ revision: 2 })
  const completed = searchSnapshot({ revision: 1 })
  for (const [snapshot, prefix] of [
    [latest, 'latest'],
    [completed, 'completed']
  ] as const) {
    for (const property of ['runId', 'revision', 'captureId'] as const) {
      const value = snapshot[property]
      Object.defineProperty(snapshot, property, {
        configurable: true,
        get: () => {
          events.push(`${prefix}.${property}`)
          return value
        }
      })
    }
  }
  const signal = {
    get aborted() {
      events.push('signal.aborted')
      return false
    }
  } as AbortSignal
  const api: SearchApi = {
    controlCharacterSearch: vi.fn<SearchApi['controlCharacterSearch']>(async (control) => {
      if (control.action === 'read') {
        return { ok: true, snapshot: searchSnapshot() }
      }
      if (control.action === 'begin') {
        return { ok: true, snapshot: completed }
      }
      throw new Error('unexpected control')
    }),
    onCharacterSearchChanged: vi.fn(() => {
      return () => {}
    })
  }
  const search = new CaptureSearch({
    api,
    notify: vi.fn(),
    onChange: vi.fn(),
    onInvalidated: vi.fn(),
    resynchronizeAuth: vi.fn()
  })
  search.connect()
  await vi.waitFor(() =>
    expect(api.controlCharacterSearch).toHaveBeenCalledWith({ action: 'read' })
  )
  ;(search as unknown as { snapshot: typeof latest }).snapshot = latest
  events.length = 0

  await search.begin({ auth: authSnapshot(), signal })
  const latestOrder = ['latest.runId', 'latest.revision', 'latest.captureId'].map((event) =>
    events.lastIndexOf(event)
  )
  const completedOrder = ['completed.runId', 'completed.revision', 'completed.captureId'].map(
    (event) => events.lastIndexOf(event)
  )
  expect(latestOrder[0]).toBeLessThan(latestOrder[1])
  expect(latestOrder[1]).toBeLessThan(latestOrder[2])
  expect(completedOrder[0]).toBeLessThan(completedOrder[1])
  expect(completedOrder[1]).toBeLessThan(completedOrder[2])

  const latestOnly = searchSnapshot({ revision: 2 })
  Object.defineProperty(latestOnly, 'captureId', {
    configurable: true,
    get: () => {
      events.push('latestOnly.captureId')
      return CAPTURE_ID
    }
  })
  ;(search as unknown as { snapshot: typeof latestOnly }).snapshot = latestOnly
  events.length = 0
  await search.begin({ auth: authSnapshot(), signal })
  expect(events).toContain('latestOnly.captureId')
  expect(events.indexOf('signal.aborted')).toBeGreaterThan(events.indexOf('latestOnly.captureId'))
})

it('Start는 현재 auth snapshot으로 begin한 뒤 반환 captureId의 media와 OCR를 시작한다', async () => {
  const fixture = createRendererFixture()
  await fixture.mount()
  await fixture.start()
  expect(fixture.search.controlCharacterSearch).toHaveBeenCalledWith({
    action: 'begin',
    authRunId: SEARCH_RUN,
    authRevision: 1
  })
  const beginOrder = fixture.search.controlCharacterSearch.mock.invocationCallOrder.at(-1)!
  expect(beginOrder).toBeLessThan(fixture.getDisplayMedia.mock.invocationCallOrder[0])
  expect(fixture.getDisplayMedia).toHaveBeenCalledOnce()
  expect(media.loop).toHaveBeenCalledOnce()
  expect(media.loop.mock.calls[0][0].getIntervalMs()).toBe(3000)

  media.crops.mockReturnValue([document.createElement('canvas'), null, null, null])
  await fixture.cycle(2)
  expect(fixture.capture.notifyStableNicknameDetected).toHaveBeenCalledExactlyOnceWith({
    captureId: CAPTURE_ID,
    slot: 0,
    observationRevision: 1,
    nickname: 'ALICE'
  })
})

it('begin 완료 전 중복 Start는 새 begin·media를 만들지 않고 진행 상태로 차단한다', async () => {
  const fixture = createRendererFixture()
  await fixture.mount()
  const begin = Promise.withResolvers<SearchCommandResult>()
  fixture.search.controlCharacterSearch.mockReturnValueOnce(begin.promise)
  await fixture.start()
  expect(fixture.search.controlCharacterSearch).toHaveBeenLastCalledWith({
    action: 'begin',
    authRunId: SEARCH_RUN,
    authRevision: 1
  })
  expect(fixture.button('Start').disabled).toBe(true)
  await fixture.click('Start')
  expect(fixture.getDisplayMedia).not.toHaveBeenCalled()
  begin.resolve({ ok: true, snapshot: searchSnapshot() })
  await act(async () => undefined)
  expect(fixture.getDisplayMedia).toHaveBeenCalledOnce()
})

it.each(['Stop', 'source', 'auth', 'unmount'] as const)(
  '%s 뒤 늦은 begin 성공은 그 ID만 end하고 media를 시작하지 않는다',
  async (transition) => {
    const fixture = createRendererFixture()
    await fixture.mount()
    const begin = Promise.withResolvers<SearchCommandResult>()
    fixture.search.controlCharacterSearch.mockReturnValueOnce(begin.promise)
    await fixture.start()
    const isStop = transition === 'Stop'
    const isSource = transition === 'source'
    const isAuth = transition === 'auth'
    if (isStop) {
      await fixture.click('Stop')
    } else if (isSource) {
      await fixture.select('next')
    } else if (isAuth) {
      await fixture.emitAuth(authSnapshot({ revision: 2, signedIn: false }))
    } else {
      await fixture.unmount()
    }
    begin.resolve({ ok: true, snapshot: searchSnapshot() })
    await act(async () => undefined)
    expect(fixture.search.controlCharacterSearch).toHaveBeenCalledWith({
      action: 'end',
      captureId: CAPTURE_ID
    })
    expect(fixture.getDisplayMedia).not.toHaveBeenCalled()
    expect(media.worker).not.toHaveBeenCalled()
  }
)

it.each([
  'Stop',
  'source',
  'auth',
  'unmount',
  'track ended',
  'media failed',
  'OCR failed'
] as const)('%s는 현재 capture ID를 end하고 stream·worker·loop를 정리한다', async (transition) => {
  const fixture = createRendererFixture()
  const loop = Promise.withResolvers<void>()
  media.loop.mockReturnValue(loop.promise)
  const isMediaFailure = transition === 'media failed'
  if (isMediaFailure) {
    fixture.getDisplayMedia.mockRejectedValueOnce(new Error('Synthetic media failure'))
  }
  await fixture.mount()
  await fixture.start()
  const isStop = transition === 'Stop'
  const isSource = transition === 'source'
  const isAuth = transition === 'auth'
  const isUnmount = transition === 'unmount'
  const isTrackEnded = transition === 'track ended'
  const isOcrFailure = transition === 'OCR failed'
  if (isStop) {
    await fixture.click('Stop')
  } else if (isSource) {
    await fixture.select('next')
  } else if (isAuth) {
    await fixture.emitAuth(authSnapshot({ revision: 2, signedIn: false }))
  } else if (isUnmount) {
    await fixture.unmount()
  } else if (isTrackEnded) {
    await act(async () => fixture.resources.track.dispatchEvent(new Event('ended')))
  } else if (isOcrFailure) {
    await act(async () => loop.reject(new Error('Synthetic OCR failure')))
  }
  expect(fixture.search.controlCharacterSearch).toHaveBeenCalledWith({
    action: 'end',
    captureId: CAPTURE_ID
  })
  if (!isMediaFailure) {
    expect(fixture.resources.track.stop).toHaveBeenCalledOnce()
    expect(fixture.resources.worker.terminate).toHaveBeenCalledOnce()
    expect(media.loop.mock.calls[0][0].signal.aborted).toBe(true)
  }
  expect(fixture.container.textContent).not.toContain('ALICE')
})

it('늦은 이전 begin은 새 capture를 end하거나 새 stream을 정리하지 않는다', async () => {
  const fixture = createRendererFixture()
  await fixture.mount()
  const first = Promise.withResolvers<SearchCommandResult>()
  fixture.search.controlCharacterSearch.mockReturnValueOnce(first.promise)
  await fixture.start()
  await fixture.click('Stop')
  const nextId = '00000000-0000-4000-8000-000000000099'
  fixture.search.controlCharacterSearch.mockResolvedValueOnce({
    ok: true,
    snapshot: searchSnapshot({ captureId: nextId, revision: 2 })
  })
  await fixture.click('Start')
  first.resolve({ ok: true, snapshot: searchSnapshot() })
  await act(async () => undefined)
  expect(fixture.search.controlCharacterSearch).toHaveBeenCalledWith({
    action: 'end',
    captureId: CAPTURE_ID
  })
  expect(fixture.search.controlCharacterSearch).not.toHaveBeenCalledWith({
    action: 'end',
    captureId: nextId
  })
  expect(fixture.resources.track.stop).not.toHaveBeenCalled()
  expect(fixture.getDisplayMedia).toHaveBeenCalledOnce()
})

it('새 capture의 늦은 이전 media 실패가 새 ID를 end하지 않는다', async () => {
  const fixture = createRendererFixture()
  const oldMedia = Promise.withResolvers<MediaStream>()
  fixture.getDisplayMedia.mockReturnValueOnce(oldMedia.promise)
  await fixture.mount()
  await fixture.start()
  await fixture.click('Stop')
  const next = captureResources()
  fixture.getDisplayMedia.mockResolvedValue(next.stream)
  media.worker.mockResolvedValue(next.worker)
  await fixture.click('Start')
  const nextId = fixture.current().captureId
  await act(async () => oldMedia.reject(new Error('Synthetic old media failure')))
  expect(fixture.search.controlCharacterSearch).toHaveBeenCalledWith({
    action: 'end',
    captureId: CAPTURE_ID
  })
  expect(fixture.search.controlCharacterSearch).not.toHaveBeenCalledWith({
    action: 'end',
    captureId: nextId
  })
  expect(next.track.stop).not.toHaveBeenCalled()
  expect(next.worker.terminate).not.toHaveBeenCalled()
})

it('stable 값이 null이 되는 전이마다 revision을 올려 clear 한 번만 보내고 기존 안정화 주기를 유지한다', async () => {
  const fixture = createRendererFixture()
  await fixture.mount()
  await fixture.start()
  const crop = document.createElement('canvas')
  media.crops.mockReturnValue([crop, null, null, null])
  await fixture.cycle(2)
  await fixture.cycle(2)
  expect(fixture.capture.notifyStableNicknameDetected).toHaveBeenCalledTimes(1)
  fixture.resources.worker.recognize.mockResolvedValue({ data: { text: 'BOB' } })
  await fixture.cycle()
  expect(fixture.search.controlCharacterSearch).toHaveBeenCalledWith({
    action: 'clear',
    captureId: CAPTURE_ID,
    slot: 0,
    observationRevision: 2
  })
  await fixture.cycle()
  expect(fixture.capture.notifyStableNicknameDetected).toHaveBeenLastCalledWith({
    captureId: CAPTURE_ID,
    slot: 0,
    observationRevision: 3,
    nickname: 'BOB'
  })
  media.crops.mockReturnValue([null, null, null, null])
  await fixture.cycle(3)
  const clears = fixture.search.controlCharacterSearch.mock.calls.filter(([command]) => {
    const isClear = command.action === 'clear'
    return isClear
  })
  expect(clears.map(([command]) => command)).toEqual([
    { action: 'clear', captureId: CAPTURE_ID, slot: 0, observationRevision: 2 },
    { action: 'clear', captureId: CAPTURE_ID, slot: 0, observationRevision: 4 }
  ])
  expect(fixture.capture.notifyStableNicknameDetected).toHaveBeenCalledTimes(2)
})

it('재로그인 뒤 source 선택과 Start 없이 이전 capture와 OCR를 재개하지 않는다', async () => {
  const fixture = createRendererFixture()
  await fixture.mount()
  await fixture.start()
  await fixture.emitAuth(authSnapshot({ revision: 2, signedIn: false }))
  await fixture.emitAuth(authSnapshot({ revision: 3, signedIn: true }))
  expect(fixture.search.controlCharacterSearch).toHaveBeenCalledWith({
    action: 'end',
    captureId: CAPTURE_ID
  })
  expect(fixture.container.querySelector('select')?.value).toBe('')
  expect(fixture.button('Start').disabled).toBe(true)
  expect(fixture.getDisplayMedia).toHaveBeenCalledOnce()
})

it('빈 OCR 문자열은 기존 stable 값을 clear 한 번으로 무효화하고 빈 frame마다 전송하지 않는다', async () => {
  const fixture = createRendererFixture()
  await fixture.mount()
  await fixture.start()
  media.crops.mockReturnValue([document.createElement('canvas'), null, null, null])
  await fixture.cycle(2)
  fixture.resources.worker.recognize.mockResolvedValue({ data: { text: '' } })
  await fixture.cycle(3)
  const clears = fixture.search.controlCharacterSearch.mock.calls.filter(([command]) => {
    const isClear = command.action === 'clear'
    return isClear
  })
  expect(clears).toEqual([
    [{ action: 'clear', captureId: CAPTURE_ID, slot: 0, observationRevision: 2 }]
  ])
  expect(fixture.capture.notifyStableNicknameDetected).toHaveBeenCalledOnce()
})

it.each(['ended', 'other capture'] as const)(
  'begin 응답보다 새로운 %s snapshot이 먼저 오면 늦은 ID로 media를 시작하지 않는다',
  async (transition) => {
    const fixture = createRendererFixture()
    await fixture.mount()
    const begin = Promise.withResolvers<SearchCommandResult>()
    fixture.search.controlCharacterSearch.mockReturnValueOnce(begin.promise)
    await fixture.start()
    const otherId = '00000000-0000-4000-8000-000000000099'
    const isEnded = transition === 'ended'
    await fixture.emit(searchSnapshot({ captureId: isEnded ? null : otherId, revision: 2 }))
    begin.resolve({ ok: true, snapshot: searchSnapshot({ captureId: CAPTURE_ID, revision: 1 }) })
    await act(async () => undefined)

    expect(fixture.getDisplayMedia).not.toHaveBeenCalled()
    expect(media.worker).not.toHaveBeenCalled()
    expect(fixture.search.controlCharacterSearch).toHaveBeenCalledWith({
      action: 'end',
      captureId: CAPTURE_ID
    })
    expect(fixture.search.controlCharacterSearch).not.toHaveBeenCalledWith({
      action: 'end',
      captureId: otherId
    })
  }
)

it.each(['older end', 'newer same capture'] as const)(
  '%s snapshot은 유효한 begin의 media 시작을 잘못 취소하지 않는다',
  async (transition) => {
    const fixture = createRendererFixture()
    await fixture.mount()
    const begin = Promise.withResolvers<SearchCommandResult>()
    fixture.search.controlCharacterSearch.mockReturnValueOnce(begin.promise)
    await fixture.start()
    const isOlderEnd = transition === 'older end'
    await fixture.emit(
      searchSnapshot({ captureId: isOlderEnd ? null : CAPTURE_ID, revision: isOlderEnd ? 1 : 3 })
    )
    begin.resolve({ ok: true, snapshot: searchSnapshot({ captureId: CAPTURE_ID, revision: 2 }) })
    await act(async () => undefined)
    expect(fixture.getDisplayMedia).toHaveBeenCalledOnce()
    expect(media.worker).toHaveBeenCalledOnce()
    expect(fixture.search.controlCharacterSearch).not.toHaveBeenCalledWith({
      action: 'end',
      captureId: CAPTURE_ID
    })
  }
)

it('취소된 Start의 begin 응답 유실 뒤 read가 새 capture를 찾아도 그 ID를 end하지 않는다', async () => {
  const fixture = createRendererFixture()
  await fixture.mount()
  const previous = Promise.withResolvers<SearchCommandResult>()
  fixture.search.controlCharacterSearch.mockReturnValueOnce(previous.promise)
  await fixture.start()
  await fixture.click('Stop')
  const nextId = '00000000-0000-4000-8000-000000000099'
  const nextSnapshot = searchSnapshot({ captureId: nextId, revision: 3 })
  fixture.search.controlCharacterSearch.mockResolvedValueOnce({ ok: true, snapshot: nextSnapshot })
  await fixture.click('Start')
  await fixture.emit(nextSnapshot)
  previous.reject(new Error('Synthetic old begin response loss'))
  await act(async () => undefined)
  expect(fixture.search.controlCharacterSearch).toHaveBeenLastCalledWith({ action: 'read' })
  expect(fixture.search.controlCharacterSearch).not.toHaveBeenCalledWith({
    action: 'end',
    captureId: nextId
  })
  expect(fixture.getDisplayMedia).toHaveBeenCalledOnce()
  expect(fixture.resources.track.stop).not.toHaveBeenCalled()
})
