// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthCaptureContext } from '../auth/capture-context'
import { CAPTURE_ID, SEARCH_RUN, searchSnapshot } from '../../../preload/api/search-test-fixture'
import type { SearchControl } from '../../../preload/common/types/search'
import { usePartyCapture } from './usePartyCapture'

const moduleMocks = vi.hoisted(() => ({
  capturePartyNicknameCrops: vi.fn(),
  createPartyOcrWorker: vi.fn(),
  runSerialLoop: vi.fn()
}))

vi.mock('./ocr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ocr')>()),
  createPartyOcrWorker: moduleMocks.createPartyOcrWorker
}))

vi.mock('./party', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./party')>()),
  capturePartyNicknameCrops: moduleMocks.capturePartyNicknameCrops
}))

vi.mock('./recognition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./recognition')>()),
  runSerialLoop: moduleMocks.runSerialLoop
}))

type HookValue = ReturnType<typeof usePartyCapture>

type LoopOptions = {
  signal: AbortSignal
  getIntervalMs: () => number
  runCycle: () => Promise<void>
}

const api = {
  listCaptureSources: vi.fn(),
  notifyStableNicknameDetected: vi.fn(),
  selectCaptureSource: vi.fn()
}

const search = { controlCharacterSearch: vi.fn(), onCharacterSearchChanged: vi.fn() }
let currentSearch = searchSnapshot({ captureId: null, revision: 0 })
const getDisplayMedia = vi.fn()

function HookHarness({ onRender }: { onRender: (value: HookValue) => void }): null {
  onRender(usePartyCapture())
  return null
}

async function renderPartyCaptureHook(): Promise<{
  getCurrent: () => HookValue
  unmount: () => Promise<void>
}> {
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  let current: HookValue | undefined

  await act(async () => {
    root.render(
      <AuthCaptureContext.Provider
        value={{
          snapshot: {
            runId: SEARCH_RUN,
            revision: 1,
            phase: 'signedIn',
            providers: [],
            login: null,
            user: { nickname: '합성 계정' },
            entry: 'home',
            notice: null
          },
          resynchronize: () => {}
        }}
      >
        <HookHarness onRender={(value) => (current = value)} />
      </AuthCaptureContext.Provider>
    )
  })

  return {
    getCurrent: () => {
      const value = current
      const hasCurrent = value != null
      if (!hasCurrent) {
        throw new Error('Hook did not render.')
      }
      return value
    },
    unmount: async () => {
      await act(async () => root.unmount())
    }
  }
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function captureResources(): {
  track: EventTarget & { stop: ReturnType<typeof vi.fn> }
  stream: MediaStream
  worker: { recognize: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }
} {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() })
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track]
  } as unknown as MediaStream
  const worker = {
    recognize: vi.fn().mockResolvedValue({ data: { text: 'Alice' } }),
    terminate: vi.fn().mockResolvedValue(undefined)
  }
  return { track, stream, worker }
}

function loadVideoMetadata(
  video: HTMLMediaElement,
  dimensions: { width?: number; height?: number } = {},
  access?: string[]
): void {
  Object.defineProperty(video, 'videoWidth', {
    configurable: true,
    get: () => {
      access?.push('videoWidth')
      return dimensions.width ?? 1920
    }
  })
  Object.defineProperty(video, 'videoHeight', {
    configurable: true,
    get: () => {
      access?.push('videoHeight')
      return dimensions.height ?? 1080
    }
  })
  video.dispatchEvent(new Event('loadedmetadata'))
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true
  })
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  Object.defineProperty(window, 'search', { configurable: true, value: search })
  currentSearch = searchSnapshot({ captureId: null, revision: 0 })
  search.onCharacterSearchChanged.mockReturnValue(() => {})
  search.controlCharacterSearch.mockImplementation(async (control: SearchControl) => {
    const isBegin = control.action === 'begin'
    const isEnd = control.action === 'end'
    const shouldChangeCapture = isBegin || isEnd
    if (shouldChangeCapture) {
      currentSearch = searchSnapshot({
        captureId: isBegin ? CAPTURE_ID : null,
        revision: currentSearch.revision + 1
      })
    }
    return { ok: true, snapshot: currentSearch }
  })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia }
  })

  api.listCaptureSources.mockResolvedValue([])
  api.notifyStableNicknameDetected.mockImplementation(async () => ({
    ok: true,
    snapshot: currentSearch
  }))
  api.selectCaptureSource.mockResolvedValue(null)
  moduleMocks.capturePartyNicknameCrops.mockReturnValue([null, null, null, null])
  moduleMocks.runSerialLoop.mockImplementation(() => new Promise<void>(() => undefined))

  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement
  ) {
    loadVideoMetadata(this)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('usePartyCapture', () => {
  it('loads sources and registers only the latest selection', async () => {
    api.listCaptureSources.mockResolvedValue([
      { id: 'old', name: 'Old window' },
      { id: 'new', name: 'New window' }
    ])
    const oldSelection = Promise.withResolvers<null>()
    const newSelection = Promise.withResolvers<null>()
    api.selectCaptureSource.mockImplementation((sourceId: string) => {
      const isOldSource = sourceId === 'old'

      return isOldSource ? oldSelection.promise : newSelection.promise
    })

    const hook = await renderPartyCaptureHook()
    await flushPromises()

    expect(hook.getCurrent().sources).toEqual([
      { id: 'old', name: 'Old window' },
      { id: 'new', name: 'New window' }
    ])

    act(() => hook.getCurrent().selectSource('old'))
    act(() => hook.getCurrent().selectSource('new'))
    await act(async () => hook.getCurrent().startCapture())

    expect(hook.getCurrent().status).toBe('Wait until the selected window is registered.')

    oldSelection.resolve(null)
    await flushPromises()
    expect(hook.getCurrent().sourceRegistered).toBe(false)

    newSelection.resolve(null)
    await flushPromises()
    expect(hook.getCurrent().selectedSourceId).toBe('new')
    expect(hook.getCurrent().sourceRegistered).toBe(true)

    await hook.unmount()
  })

  it('recognizes stable nicknames and releases capture resources on stop', async () => {
    const { track, stream, worker } = captureResources()
    const nicknameCrop = document.createElement('canvas')
    let loopOptions: LoopOptions | undefined

    getDisplayMedia.mockResolvedValue(stream)
    moduleMocks.createPartyOcrWorker.mockResolvedValue(worker)
    moduleMocks.capturePartyNicknameCrops.mockReturnValue([nicknameCrop, null, null, null])
    moduleMocks.runSerialLoop.mockImplementation((options: LoopOptions) => {
      loopOptions = options
      return new Promise<void>(() => undefined)
    })

    const hook = await renderPartyCaptureHook()
    act(() => hook.getCurrent().selectSource('game'))
    await flushPromises()

    await act(async () => hook.getCurrent().startCapture())

    expect(getDisplayMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        frameRate: { ideal: 1, max: 1 },
        height: { ideal: 1080 },
        width: { ideal: 1920 }
      }
    })
    expect(hook.getCurrent().status).toBe('Capture ready at 1920×1080.')
    expect(worker.recognize).not.toHaveBeenCalled()
    expect(loopOptions?.getIntervalMs()).toBe(3000)

    await act(async () => loopOptions?.runCycle())
    await act(async () => loopOptions?.runCycle())

    expect(worker.recognize).toHaveBeenCalledTimes(2)
    expect(worker.recognize).toHaveBeenCalledWith(nicknameCrop)
    expect(hook.getCurrent().stableNicknames[0]).toBe('Alice')
    expect(api.notifyStableNicknameDetected).toHaveBeenCalledTimes(1)
    expect(api.notifyStableNicknameDetected).toHaveBeenCalledWith({
      captureId: CAPTURE_ID,
      observationRevision: 1,
      nickname: 'Alice',
      slot: 0
    })

    act(() => hook.getCurrent().stopCapture())

    expect(track.stop).toHaveBeenCalledOnce()
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(hook.getCurrent().stableNicknames).toEqual([null, null, null, null])
    expect(hook.getCurrent().status).toBe('Capture stopped.')
    expect(loopOptions?.signal.aborted).toBe(true)

    await hook.unmount()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it.each([
    { width: 1600, height: 1080 },
    { width: 1920, height: 900 }
  ])('rejects unsupported capture layout $width×$height before OCR starts', async (dimensions) => {
    const { stream, track } = captureResources()
    const access: string[] = []
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(async function (
      this: HTMLMediaElement
    ) {
      loadVideoMetadata(this, dimensions, access)
    })
    getDisplayMedia.mockResolvedValue(stream)
    const hook = await renderPartyCaptureHook()
    act(() => hook.getCurrent().selectSource('game'))
    await flushPromises()

    await act(async () => hook.getCurrent().startCapture())

    expect(hook.getCurrent().status).toBe(
      `Unsupported capture layout: ${dimensions.width}×${dimensions.height}.`
    )
    expect(track.stop).toHaveBeenCalledOnce()
    expect(moduleMocks.createPartyOcrWorker).not.toHaveBeenCalled()
    expect(moduleMocks.runSerialLoop).not.toHaveBeenCalled()
    expect(access).toEqual(
      dimensions.width === 1920
        ? ['videoWidth', 'videoHeight', 'videoWidth', 'videoHeight']
        : ['videoWidth', 'videoWidth', 'videoHeight']
    )

    await hook.unmount()
  })

  it.each(['unmount', 'new capture'] as const)(
    '%s 뒤 이전 OCR은 안정화 통지를 보내지 않는다',
    async (mode) => {
      const { stream, worker } = captureResources()
      const crop = document.createElement('canvas')
      const pendingRecognition = Promise.withResolvers<{ data: { text: string } }>()
      let loopOptions: LoopOptions | undefined
      getDisplayMedia.mockResolvedValue(stream)
      moduleMocks.createPartyOcrWorker.mockResolvedValue(worker)
      moduleMocks.capturePartyNicknameCrops.mockReturnValue([crop, null, null, null])
      moduleMocks.runSerialLoop.mockImplementation((options: LoopOptions) => {
        loopOptions = options
        return new Promise<void>(() => undefined)
      })
      const hook = await renderPartyCaptureHook()
      act(() => hook.getCurrent().selectSource('game'))
      await flushPromises()
      await act(async () => hook.getCurrent().startCapture())
      await act(async () => loopOptions?.runCycle())
      worker.recognize.mockReturnValueOnce(pendingRecognition.promise)
      const lateCycle = loopOptions?.runCycle()
      await hook.unmount()
      const shouldRestart = mode === 'new capture'
      const nextHook = shouldRestart ? await renderPartyCaptureHook() : null
      const hasNextHook = nextHook != null
      if (hasNextHook) {
        act(() => nextHook.getCurrent().selectSource('game'))
        await flushPromises()
        await act(async () => nextHook.getCurrent().startCapture())
      }
      pendingRecognition.resolve({ data: { text: 'Alice' } })
      await act(async () => lateCycle)
      expect(api.notifyStableNicknameDetected).not.toHaveBeenCalled()
      if (hasNextHook) {
        expect(nextHook.getCurrent().stableNicknames).toEqual([null, null, null, null])
        expect(nextHook.getCurrent().status).toBe('Capture ready at 1920×1080.')
        await nextHook.unmount()
      }
      expect(api.selectCaptureSource).toHaveBeenLastCalledWith('')
    }
  )

  it('stops a stream that resolves after capture was cancelled', async () => {
    const { track, stream } = captureResources()
    const pendingStream = Promise.withResolvers<MediaStream>()

    getDisplayMedia.mockReturnValue(pendingStream.promise)
    const hook = await renderPartyCaptureHook()
    act(() => hook.getCurrent().selectSource('game'))
    await flushPromises()

    let startCapture!: Promise<void>
    act(() => {
      startCapture = hook.getCurrent().startCapture()
    })
    await flushPromises()
    act(() => hook.getCurrent().stopCapture('Capture cancelled.'))
    pendingStream.resolve(stream)
    await act(async () => startCapture)

    expect(track.stop).toHaveBeenCalledOnce()
    expect(moduleMocks.createPartyOcrWorker).not.toHaveBeenCalled()
    expect(hook.getCurrent().status).toBe('Capture cancelled.')

    await hook.unmount()
  })

  it.each(['track ended', 'OCR failed'] as const)(
    'releases the active session when %s',
    async (reason) => {
      const { stream, track, worker } = captureResources()
      const loop = Promise.withResolvers<void>()
      getDisplayMedia.mockResolvedValue(stream)
      moduleMocks.createPartyOcrWorker.mockResolvedValue(worker)
      moduleMocks.runSerialLoop.mockReturnValue(loop.promise)
      const hook = await renderPartyCaptureHook()
      act(() => hook.getCurrent().selectSource('game'))
      await flushPromises()
      await act(async () => hook.getCurrent().startCapture())
      const video = vi.mocked(HTMLMediaElement.prototype.play).mock.contexts[0] as HTMLMediaElement
      const { signal } = moduleMocks.runSerialLoop.mock.calls[0][0] as LoopOptions
      const isTrackEnded = reason === 'track ended'

      if (isTrackEnded) {
        act(() => track.dispatchEvent(new Event('ended')))
      } else {
        await act(async () => loop.reject(new Error('Party OCR failed.')))
      }

      expect(signal.aborted).toBe(true)
      expect(track.stop).toHaveBeenCalledOnce()
      expect(video.pause).toHaveBeenCalledOnce()
      expect(video.srcObject).toBeNull()
      expect(worker.terminate).toHaveBeenCalledOnce()
      expect(hook.getCurrent().status).toBe(isTrackEnded ? 'Capture ended.' : 'Party OCR failed.')
      await hook.unmount()
      expect(track.stop).toHaveBeenCalledOnce()
      expect(worker.terminate).toHaveBeenCalledOnce()
    }
  )

  it.each(['stop', 'unmount'] as const)(
    'releases a video still waiting for playback on %s',
    async (action) => {
      const { stream, track } = captureResources()
      const playback = Promise.withResolvers<void>()
      vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(function (
        this: HTMLMediaElement
      ) {
        loadVideoMetadata(this)
        return playback.promise
      })
      getDisplayMedia.mockResolvedValue(stream)
      const hook = await renderPartyCaptureHook()
      act(() => hook.getCurrent().selectSource('game'))
      await flushPromises()

      let start!: Promise<void>
      act(() => {
        start = hook.getCurrent().startCapture()
      })
      await flushPromises()
      const video = vi.mocked(HTMLMediaElement.prototype.play).mock.contexts[0] as HTMLMediaElement
      const shouldStop = action === 'stop'
      if (shouldStop) {
        act(() => hook.getCurrent().stopCapture('Capture cancelled.'))
      } else {
        await hook.unmount()
      }

      expect(track.stop).toHaveBeenCalledOnce()
      expect(video.pause).toHaveBeenCalledOnce()
      expect(video.srcObject).toBeNull()
      playback.resolve()
      await act(async () => start)
      expect(moduleMocks.createPartyOcrWorker).not.toHaveBeenCalled()
      expect(moduleMocks.runSerialLoop).not.toHaveBeenCalled()
      if (shouldStop) {
        expect(hook.getCurrent().status).toBe('Capture cancelled.')
        await hook.unmount()
      }
      expect(video.pause).toHaveBeenCalledOnce()
    }
  )

  it('cancels metadata waiting without requiring a later video event', async () => {
    const { stream, track } = captureResources()
    vi.mocked(HTMLMediaElement.prototype.play).mockResolvedValueOnce(undefined)
    getDisplayMedia.mockResolvedValue(stream)
    const hook = await renderPartyCaptureHook()
    act(() => hook.getCurrent().selectSource('game'))
    await flushPromises()

    let settled = false
    let start!: Promise<void>
    act(() => {
      start = hook
        .getCurrent()
        .startCapture()
        .then(() => {
          settled = true
        })
    })
    await flushPromises()
    const video = vi.mocked(HTMLMediaElement.prototype.play).mock.contexts[0] as HTMLMediaElement
    act(() => hook.getCurrent().stopCapture('Capture cancelled.'))
    await flushPromises()

    expect(settled).toBe(true)
    await start
    expect(track.stop).toHaveBeenCalledOnce()
    expect(video.srcObject).toBeNull()
    loadVideoMetadata(video)
    await flushPromises()
    expect(moduleMocks.createPartyOcrWorker).not.toHaveBeenCalled()
    expect(hook.getCurrent().status).toBe('Capture cancelled.')
    await hook.unmount()
  })

  it('releases a late stream without stopping the replacement session', async () => {
    const previous = captureResources()
    const current = captureResources()
    const pendingStream = Promise.withResolvers<MediaStream>()
    getDisplayMedia.mockReturnValueOnce(pendingStream.promise).mockResolvedValue(current.stream)
    moduleMocks.createPartyOcrWorker.mockResolvedValue(current.worker)
    const hook = await renderPartyCaptureHook()
    act(() => hook.getCurrent().selectSource('game'))
    await flushPromises()

    let firstStart!: Promise<void>
    act(() => {
      firstStart = hook.getCurrent().startCapture()
    })
    await flushPromises()
    await act(async () => hook.getCurrent().startCapture())
    pendingStream.resolve(previous.stream)
    await act(async () => firstStart)

    expect(previous.track.stop).toHaveBeenCalledOnce()
    expect(current.track.stop).not.toHaveBeenCalled()
    expect(current.worker.terminate).not.toHaveBeenCalled()
    expect(moduleMocks.runSerialLoop).toHaveBeenCalledOnce()
    expect(hook.getCurrent().status).toBe('Capture ready at 1920×1080.')
    await hook.unmount()
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores an old worker initialization that later %ss after restart',
    async (outcome) => {
      const previous = captureResources()
      const current = captureResources()
      const pendingWorker = Promise.withResolvers<typeof previous.worker>()
      getDisplayMedia.mockResolvedValueOnce(previous.stream).mockResolvedValue(current.stream)
      moduleMocks.createPartyOcrWorker
        .mockReturnValueOnce(pendingWorker.promise)
        .mockResolvedValue(current.worker)
      const hook = await renderPartyCaptureHook()
      act(() => hook.getCurrent().selectSource('game'))
      await flushPromises()

      let firstStart!: Promise<void>
      act(() => {
        firstStart = hook.getCurrent().startCapture()
      })
      await flushPromises()
      expect(moduleMocks.createPartyOcrWorker).toHaveBeenCalledOnce()
      await act(async () => hook.getCurrent().startCapture())
      const shouldResolve = outcome === 'resolve'
      if (shouldResolve) {
        pendingWorker.resolve(previous.worker)
      } else {
        pendingWorker.reject(new Error('Old worker failed.'))
      }
      await act(async () => firstStart)

      expect(previous.track.stop).toHaveBeenCalledOnce()
      expect(previous.worker.terminate).toHaveBeenCalledTimes(shouldResolve ? 1 : 0)
      expect(previous.worker.recognize).not.toHaveBeenCalled()
      expect(current.track.stop).not.toHaveBeenCalled()
      expect(current.worker.terminate).not.toHaveBeenCalled()
      expect(moduleMocks.runSerialLoop).toHaveBeenCalledOnce()
      expect(hook.getCurrent().status).toBe('Capture ready at 1920×1080.')
      previous.track.dispatchEvent(new Event('ended'))
      expect(current.track.stop).not.toHaveBeenCalled()
      await hook.unmount()
    }
  )

  it('terminates a worker that finishes initialization after unmount', async () => {
    const { stream, track, worker } = captureResources()
    const pendingWorker = Promise.withResolvers<typeof worker>()
    getDisplayMedia.mockResolvedValue(stream)
    moduleMocks.createPartyOcrWorker.mockReturnValue(pendingWorker.promise)
    const hook = await renderPartyCaptureHook()
    act(() => hook.getCurrent().selectSource('game'))
    await flushPromises()

    let start!: Promise<void>
    act(() => {
      start = hook.getCurrent().startCapture()
    })
    await flushPromises()
    await hook.unmount()
    pendingWorker.resolve(worker)
    await act(async () => start)

    expect(track.stop).toHaveBeenCalledOnce()
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(worker.recognize).not.toHaveBeenCalled()
    expect(moduleMocks.runSerialLoop).not.toHaveBeenCalled()
  })

  it('releases a video when playback fails', async () => {
    const { stream, track } = captureResources()
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('Playback failed.'))
    getDisplayMedia.mockResolvedValue(stream)
    const hook = await renderPartyCaptureHook()
    act(() => hook.getCurrent().selectSource('game'))
    await flushPromises()

    await act(async () => hook.getCurrent().startCapture())

    const video = vi.mocked(HTMLMediaElement.prototype.play).mock.contexts[0] as HTMLMediaElement
    expect(track.stop).toHaveBeenCalledOnce()
    expect(video.pause).toHaveBeenCalledOnce()
    expect(video.srcObject).toBeNull()
    expect(hook.getCurrent().status).toBe('Playback failed.')
    expect(moduleMocks.createPartyOcrWorker).not.toHaveBeenCalled()
    await hook.unmount()
  })

  it('releases all stream tracks when no video track is available', async () => {
    const { stream, track } = captureResources()
    stream.getVideoTracks = () => []
    getDisplayMedia.mockResolvedValue(stream)
    const hook = await renderPartyCaptureHook()
    act(() => hook.getCurrent().selectSource('game'))
    await flushPromises()

    await act(async () => hook.getCurrent().startCapture())

    expect(track.stop).toHaveBeenCalledOnce()
    expect(hook.getCurrent().status).toBe('The selected window did not provide a video track.')
    expect(moduleMocks.createPartyOcrWorker).not.toHaveBeenCalled()
    await hook.unmount()
  })
})
