// @vitest-environment jsdom
import { act } from 'react'
import { expect, it } from 'vitest'
import type { SearchCommandResult } from '../../../preload/common/types/search'
import { CAPTURE_ID, searchSnapshot, SEARCH_RUN } from '../../../preload/api/search-test-fixture'
import {
  authSnapshot,
  captureResources,
  createRendererFixture,
  media
} from './search-renderer-test-fixture'

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
      await fixture.emitAuth(authSnapshot(2, false))
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
    await fixture.emitAuth(authSnapshot(2, false))
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
  await fixture.emitAuth(authSnapshot(2, false))
  await fixture.emitAuth(authSnapshot(3, true))
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
