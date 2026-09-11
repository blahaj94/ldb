// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { bootstrapAuthRuntime } from '../../../backend/auth/bootstrap'
import { registerAuthIpc } from '../../../backend/auth/ipc-handler'
import {
  createAuthHarness,
  CODE,
  deferred,
  RETURN_TARGET
} from '../../../backend/auth/auth-test-fixtures'
import type { AuthRuntimeConfig } from '../../../backend/auth/runtime-config'
import { registerCaptureIpc, registerCaptureWindow } from '../../../backend/capture/ipc-handler'
import App from '../App'
import * as authApi from '../../../preload/api/auth'
import * as captureApi from '../../../preload/api/capture'
import * as searchApi from '../../../preload/api/search'

const electron = vi.hoisted(() => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  type Listener = (...args: unknown[]) => void

  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Set<Listener>>()
  let invokeEvent: IpcMainInvokeEvent | null = null

  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    })
  }
  const ipcRenderer = {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel)
      if (handler == null || invokeEvent == null) {
        throw new Error(`Missing IPC route: ${channel}`)
      }
      return handler(invokeEvent, ...args)
    }),
    on: vi.fn((channel: string, listener: Listener) => {
      const channelListeners = listeners.get(channel) ?? new Set<Listener>()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      listeners.get(channel)?.delete(listener)
    })
  }

  return {
    ipcMain,
    ipcRenderer,
    desktopCapturer: {
      getSources: vi.fn(async () => [{ id: 'window:synthetic', name: 'Synthetic game window' }])
    },
    setInvokeEvent(event: IpcMainInvokeEvent): void {
      invokeEvent = event
    },
    emit(channel: string, value: unknown): void {
      for (const listener of listeners.get(channel) ?? []) {
        listener({}, value)
      }
    },
    reset(): void {
      handlers.clear()
      listeners.clear()
      invokeEvent = null
      ipcMain.handle.mockClear()
      ipcMain.removeHandler.mockClear()
      ipcRenderer.invoke.mockClear()
      ipcRenderer.on.mockClear()
      ipcRenderer.removeListener.mockClear()
    }
  }
})

vi.mock('electron', () => electron)

const ocrWorker = vi.hoisted(() => ({
  recognize: vi.fn(async () => ({ data: { text: 'ALICE' } })),
  terminate: vi.fn(async () => undefined)
}))

vi.mock('../capture/ocr', () => ({
  createPartyOcrWorker: vi.fn(async () => ocrWorker)
}))

const DOCUMENT_URL = 'file:///fixture/index.html'
const RENDERER_SOURCE_ID = 'window:synthetic'
const RENDERER_SOURCE_NAME = 'Synthetic game window'

const config: AuthRuntimeConfig = {
  apiOrigin: 'https://api.example.test',
  returnTarget: RETURN_TARGET,
  environment: 'test',
  providers: ['google', 'discord'],
  appIdentity: 'com.synthetic.ldb',
  userDataPath: '/synthetic/user-data'
}

type FixtureWindow = {
  window: BrowserWindow
  frame: { url: string; detached: boolean; isDestroyed: ReturnType<typeof vi.fn> }
  contents: {
    mainFrame: unknown
    isDestroyed: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    session: { setDisplayMediaRequestHandler: ReturnType<typeof vi.fn> }
    on: ReturnType<typeof vi.fn>
  }
  close: () => void
}

function createFixtureWindow(): FixtureWindow {
  const frame = { url: DOCUMENT_URL, detached: false, isDestroyed: vi.fn(() => false) }
  const contents = {
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
    send: vi.fn((channel: string, value: unknown) => electron.emit(channel, value)),
    session: { setDisplayMediaRequestHandler: vi.fn() },
    on: vi.fn()
  }
  const windowEvents = new Map<string, () => void>()
  const fixtureWindow = {
    webContents: contents,
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, listener: () => void) => {
      windowEvents.set(event, listener)
    })
  }
  const event = {
    sender: contents,
    senderFrame: frame
  } as unknown as IpcMainInvokeEvent
  electron.setInvokeEvent(event)

  return {
    window: fixtureWindow as unknown as BrowserWindow,
    frame,
    contents,
    close: () => windowEvents.get('closed')?.()
  }
}

function installMediaBoundary(): {
  media: { getDisplayMedia: ReturnType<typeof vi.fn> }
  track: { stop: ReturnType<typeof vi.fn>; readyState: string }
} {
  const track = new EventTarget() as EventTarget & {
    stop: ReturnType<typeof vi.fn>
    readyState: string
  }
  track.readyState = 'live'
  track.stop = vi.fn(() => {
    track.readyState = 'ended'
  })
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track]
  } as unknown as MediaStream
  const media = { getDisplayMedia: vi.fn(async () => stream) }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: media })
  return { media, track }
}

function installCanvasBoundary(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        drawImage: vi.fn(),
        getImageData: vi.fn((x: number, y: number, width: number, height: number) => {
          const isFirstSlotMana = x === 42 && y === 36 && width === 105 && height === 5
          if (!isFirstSlotMana) {
            return { data: new Uint8ClampedArray(width * height * 4) }
          }
          const data = new Uint8ClampedArray(width * height * 4)
          for (let index = 0; index < data.length; index += 4) {
            data[index] = 55
            data[index + 1] = 121
            data[index + 2] = 170
            data[index + 3] = 255
          }
          return { data }
        })
      }) as unknown as CanvasRenderingContext2D
  )
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement
  ) {
    Object.defineProperty(this, 'videoWidth', { configurable: true, value: 1920 })
    Object.defineProperty(this, 'videoHeight', { configurable: true, value: 1080 })
    this.dispatchEvent(new Event('loadedmetadata'))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
}

function button(container: HTMLDivElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label
  )
  expect(found, `Expected button ${label}`).toBeDefined()
  return found as HTMLButtonElement
}

async function click(container: HTMLDivElement, label: string): Promise<void> {
  await act(async () => button(container, label).click())
}

async function renderSettled(): Promise<void> {
  await act(async () => undefined)
}

async function waitForCondition(
  assertion: () => void,
  options?: { timeout?: number }
): Promise<void> {
  await act(async () => {
    await vi.waitFor(assertion, options)
  })
}

async function waitForText(container: HTMLDivElement, text: string): Promise<void> {
  await waitForCondition(() => expect(container.textContent).toContain(text))
}

beforeEach(() => {
  electron.reset()
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  installCanvasBoundary()
})

afterEach(() => {
  vi.restoreAllMocks()
})

it('제품 bootstrap부터 auth IPC, capture/search IPC, renderer logout과 재로그인을 한 계약으로 연결한다', async () => {
  const harness = createAuthHarness()
  const liveSearch = deferred<Response>()
  const lateSearch = deferred<Response>()
  const lateResponseDelivered = deferred<void>()
  const observedRequests: Request[] = []
  const searchFetch = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init)
    observedRequests.push(request)
    if (observedRequests.length === 1) {
      return liveSearch.promise
    }
    if (observedRequests.length === 2) {
      return lateSearch.promise.then((response) => {
        lateResponseDelivered.resolve()
        return response
      })
    }
    throw new Error('Unexpected third search request')
  })
  const runtime = await bootstrapAuthRuntime({
    config,
    effects: {
      announceCredentialAccess: vi.fn(async () => undefined),
      createDependencies: () => harness.dependencies,
      createSearchClock: () => harness.clock
    }
  })
  if (runtime == null) {
    throw new Error('Synthetic auth runtime should be available')
  }
  await runtime.start()

  const fixtureWindow = createFixtureWindow()
  const disposeAuth = registerAuthIpc({
    coordinator: runtime.coordinator,
    getWindow: () => fixtureWindow.window,
    documentUrl: DOCUMENT_URL
  })
  registerCaptureWindow(fixtureWindow.window, DOCUMENT_URL)
  const disposeCapture = registerCaptureIpc(runtime.coordinator, {
    apiOrigin: runtime.apiOrigin,
    fetch: searchFetch,
    clock: runtime.searchClock
  })

  const { media, track } = installMediaBoundary()
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  Object.defineProperty(window, 'auth', { configurable: true, value: authApi })
  Object.defineProperty(window, 'api', { configurable: true, value: captureApi })
  Object.defineProperty(window, 'search', { configurable: true, value: searchApi })

  try {
    await act(async () => root.render(<App />))
    await waitForText(container, 'Google로 계속하기')

    await click(container, 'Google로 계속하기')
    await waitForCondition(() =>
      expect(runtime.coordinator.getSnapshot().phase).toBe('waitingBrowser')
    )
    await act(async () => {
      await runtime.coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    })
    await waitForText(container, '시작하기')

    await click(container, '시작하기')
    await waitForCondition(() => {
      const source = container.querySelector('select') as HTMLSelectElement | null
      expect(source?.options).toHaveLength(2)
      expect(source?.options[1]?.textContent).toBe(RENDERER_SOURCE_NAME)
    })
    const source = container.querySelector('select') as HTMLSelectElement
    await act(async () => {
      source.value = RENDERER_SOURCE_ID
      source.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitForCondition(() => expect(button(container, 'Start').disabled).toBe(false))

    await click(container, 'Start')
    await waitForText(container, 'Capture ready at 1920×1080.')
    expect(media.getDisplayMedia).toHaveBeenCalledOnce()
    expect(ocrWorker.terminate).not.toHaveBeenCalled()

    const searchState = await searchApi.controlCharacterSearch({ action: 'read' })
    expect(searchState.ok).toBe(true)
    if (!searchState.ok || searchState.snapshot.captureId == null) {
      throw new Error('Integrated capture should own a search capture')
    }
    const captureId = searchState.snapshot.captureId
    await waitForCondition(
      () => expect(ocrWorker.recognize.mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 5_000 }
    )
    await waitForCondition(() => expect(observedRequests).toHaveLength(1), { timeout: 5_000 })
    expect(observedRequests[0]?.url).toBe(`${config.apiOrigin}/characters?characterName=ALICE`)
    expect(observedRequests[0]?.headers.get('authorization')).toBe('Bearer next.payload.signature')
    await waitForText(container, 'ALICE')
    await waitForText(container, '검색 중')
    const pendingSearchEvents = fixtureWindow.contents.send.mock.calls.filter(
      ([channel, value]) =>
        channel === 'characterSearchChanged' &&
        (value as { captureId?: string; slots?: Array<{ state?: string }> }).captureId ===
          captureId &&
        (value as { slots?: Array<{ state?: string }> }).slots?.[0]?.state === 'pending'
    )
    expect(pendingSearchEvents.length).toBeGreaterThan(0)

    await act(async () => {
      liveSearch.resolve(
        new Response(
          JSON.stringify({
            rows: [
              {
                characterId: 'live-character',
                characterName: 'ALICE',
                serverId: 'cain',
                serverName: '카인',
                fame: 54321
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      await Promise.resolve()
    })
    await waitForText(container, 'live-character')

    ocrWorker.recognize.mockResolvedValue({ data: { text: 'BOB' } })
    await waitForCondition(() => expect(observedRequests).toHaveLength(2), { timeout: 10_000 })
    expect(observedRequests[1]?.url).toBe(`${config.apiOrigin}/characters?characterName=BOB`)
    expect(observedRequests[1]?.headers.get('authorization')).toBe('Bearer next.payload.signature')
    await waitForText(container, 'BOB')
    await waitForText(container, '검색 중')

    await click(container, '이 기기 로그아웃')
    await waitForText(container, 'Google로 계속하기')
    expect(runtime.coordinator.getSnapshot()).toMatchObject({ phase: 'signedOut', notice: null })
    expect(harness.http.logout).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.any(AbortSignal)
    )
    expect(harness.store.inspection).toEqual({ status: 'empty' })
    await waitForCondition(() => expect(track.stop).toHaveBeenCalledOnce())
    await waitForCondition(() => expect(ocrWorker.terminate).toHaveBeenCalledOnce())
    expect(fixtureWindow.contents.send.mock.calls.map(([channel]) => channel)).toContain(
      'authStateChanged'
    )
    expect(fixtureWindow.contents.send.mock.calls.map(([channel]) => channel)).toContain(
      'characterSearchChanged'
    )
    const searchEvents = fixtureWindow.contents.send.mock.calls.filter(
      ([channel]) => channel === 'characterSearchChanged'
    )
    expect(searchEvents.at(-1)?.[1]).toMatchObject({ captureId: null })

    lateSearch.resolve(
      new Response(
        JSON.stringify({
          rows: [
            {
              characterId: 'late-character',
              characterName: 'BOB',
              serverId: 'cain',
              serverName: '카인',
              fame: 12345
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    await act(async () => {
      await lateResponseDelivered.promise
    })
    await renderSettled()
    expect(container.textContent).not.toContain('late-character')
    expect(container.textContent).not.toContain('화면 캡처')

    await click(container, 'Google로 계속하기')
    await waitForCondition(() =>
      expect(runtime.coordinator.getSnapshot().phase).toBe('waitingBrowser')
    )
    await act(async () => {
      await runtime.coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    })
    await waitForText(container, '시작하기')
    await click(container, '시작하기')
    await waitForCondition(() => {
      const nextSource = container.querySelector('select') as HTMLSelectElement | null
      expect(nextSource?.options).toHaveLength(2)
      expect(nextSource?.value).toBe('')
      expect(button(container, 'Start').disabled).toBe(true)
    })
    expect(container.textContent).not.toContain('late-character')
    expect(media.getDisplayMedia).toHaveBeenCalledOnce()
    expect(harness.http.exchange).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    disposeCapture()
    disposeAuth()
    fixtureWindow.close()
  }
}, 20_000)
