// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePartyCapture } from './usePartyCapture'

const moduleMocks = vi.hoisted(() => ({
  capturePartyNicknameCrops: vi.fn(),
  createPartyOcrWorker: vi.fn(),
  runSerialLoop: vi.fn()
}))

vi.mock('../utils/ocr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/ocr')>()),
  createPartyOcrWorker: moduleMocks.createPartyOcrWorker
}))

vi.mock('../utils/party', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/party')>()),
  capturePartyNicknameCrops: moduleMocks.capturePartyNicknameCrops
}))

vi.mock('../utils/recognition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/recognition')>()),
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
    root.render(<HookHarness onRender={(value) => (current = value)} />)
  })

  return {
    getCurrent: () => {
      if (!current) throw new Error('Hook did not render.')
      return current
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

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true
  })
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia }
  })

  api.listCaptureSources.mockResolvedValue([])
  api.notifyStableNicknameDetected.mockResolvedValue(undefined)
  api.selectCaptureSource.mockResolvedValue(null)
  moduleMocks.capturePartyNicknameCrops.mockReturnValue([null, null, null, null])
  moduleMocks.runSerialLoop.mockImplementation(() => new Promise<void>(() => undefined))

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: vi.fn(),
    fillStyle: '',
    fillText: vi.fn(),
    font: ''
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement
  ) {
    Object.defineProperty(this, 'videoWidth', { configurable: true, value: 1920 })
    Object.defineProperty(this, 'videoHeight', { configurable: true, value: 1080 })
    this.dispatchEvent(new Event('loadedmetadata'))
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
    const oldSelection = deferred<null>()
    const newSelection = deferred<null>()
    api.selectCaptureSource.mockImplementation((sourceId: string) =>
      sourceId === 'old' ? oldSelection.promise : newSelection.promise
    )

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
    const track = {
      addEventListener: vi.fn(),
      stop: vi.fn()
    }
    const stream = {
      getTracks: () => [track],
      getVideoTracks: () => [track]
    } as unknown as MediaStream
    const worker = {
      recognize: vi
        .fn()
        .mockResolvedValueOnce({ data: { text: '테스트 ABC123' } })
        .mockResolvedValue({ data: { text: 'Alice' } }),
      terminate: vi.fn().mockResolvedValue(undefined)
    }
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
    expect(hook.getCurrent().status).toBe('Capture ready at 1920×1080; offline OCR: 테스트ABC123.')
    expect(loopOptions?.getIntervalMs()).toBe(3000)

    await act(async () => loopOptions?.runCycle())
    await act(async () => loopOptions?.runCycle())

    expect(hook.getCurrent().stableNicknames[0]).toBe('Alice')
    expect(api.notifyStableNicknameDetected).toHaveBeenCalledTimes(1)
    expect(api.notifyStableNicknameDetected).toHaveBeenCalledWith({ nickname: 'Alice', slot: 0 })

    act(() => hook.getCurrent().stopCapture())

    expect(track.stop).toHaveBeenCalledOnce()
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(hook.getCurrent().stableNicknames).toEqual([null, null, null, null])
    expect(hook.getCurrent().status).toBe('Capture stopped.')

    await hook.unmount()
  })
})
