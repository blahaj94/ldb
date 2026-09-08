import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, vi, type Mocked } from 'vitest'
import type { AuthApi, AuthSnapshot } from '../../../preload/common/types/auth'
import type { SearchCommandResult, SearchSnapshot } from '../../../preload/common/types/search'
import {
  CAPTURE_ID,
  SEARCH_RUN,
  searchSlot,
  searchSnapshot,
  type SearchTestApi,
  type ObservationTestApi
} from '../../../preload/api/search-test-fixture'
import App from '../App'

const media = vi.hoisted(() => ({ crops: vi.fn(), worker: vi.fn(), loop: vi.fn() }))
vi.mock('../capture/ocr', async (original) => ({
  ...(await original<typeof import('../capture/ocr')>()),
  createPartyOcrWorker: media.worker
}))
vi.mock('../capture/party', async (original) => ({
  ...(await original<typeof import('../capture/party')>()),
  capturePartyNicknameCrops: media.crops
}))
vi.mock('../capture/recognition', async (original) => ({
  ...(await original<typeof import('../capture/recognition')>()),
  runSerialLoop: media.loop
}))

type Loop = { signal: AbortSignal; getIntervalMs: () => number; runCycle: () => Promise<void> }
const cleanup: Array<() => Promise<void>> = []

export function authSnapshot(revision = 1, signedIn = true): AuthSnapshot {
  return {
    runId: SEARCH_RUN,
    revision,
    phase: signedIn ? 'signedIn' : 'signedOut',
    providers: [],
    login: null,
    user: signedIn ? { nickname: '합성 계정' } : null,
    entry: signedIn ? 'home' : null,
    notice: null
  }
}

type CaptureResources = {
  track: EventTarget & { stop: ReturnType<typeof vi.fn> }
  stream: MediaStream
  worker: { recognize: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }
}
type RendererFixture = {
  container: HTMLDivElement
  search: Mocked<SearchTestApi>
  capture: {
    listCaptureSources: ReturnType<typeof vi.fn>
    selectCaptureSource: ReturnType<typeof vi.fn>
    notifyStableNicknameDetected: Mocked<ObservationTestApi>['notifyStableNicknameDetected']
  }
  auth: Mocked<AuthApi>
  resources: CaptureResources
  getDisplayMedia: ReturnType<typeof vi.fn>
  order: string[]
  mount: () => Promise<void>
  unmount: () => Promise<void>
  button: (label: string, within?: ParentNode) => HTMLButtonElement
  select: (source?: string) => Promise<void>
  click: (label: string) => Promise<void>
  start: () => Promise<void>
  cycle: (count?: number) => Promise<void>
  emit: (snapshot: SearchSnapshot) => Promise<void>
  emitAuth: (snapshot: AuthSnapshot) => Promise<void>
  current: () => SearchSnapshot
  result: () => SearchCommandResult
}

export function captureResources(): CaptureResources {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() })
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track]
  } as unknown as MediaStream
  const worker = {
    recognize: vi.fn().mockResolvedValue({ data: { text: 'ALICE' } }),
    terminate: vi.fn().mockResolvedValue(undefined)
  }
  return { track, stream, worker }
}

export function createRendererFixture(): RendererFixture {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  let mounted = true
  let currentSearch = searchSnapshot({ captureId: null, revision: 0 })
  let currentAuth = authSnapshot()
  let sequence = 0
  const order: string[] = []
  const searchListeners = new Set<(snapshot: SearchSnapshot) => void>()
  const authListeners = new Set<(snapshot: AuthSnapshot) => void>()
  const resources = captureResources()
  const getDisplayMedia = vi.fn().mockResolvedValue(resources.stream)
  const search = {
    controlCharacterSearch: vi
      .fn<SearchTestApi['controlCharacterSearch']>()
      .mockImplementation(async (command) => {
        order.push(command.action)
        const isBegin = command.action === 'begin'
        if (isBegin) {
          sequence += 1
          const captureId =
            sequence === 1
              ? CAPTURE_ID
              : `00000000-0000-4000-8000-${String(100 + sequence).padStart(12, '0')}`
          currentSearch = searchSnapshot({ captureId, revision: currentSearch.revision + 1 })
        }
        return { ok: true, snapshot: currentSearch }
      }),
    onCharacterSearchChanged: vi
      .fn<SearchTestApi['onCharacterSearchChanged']>()
      .mockImplementation((listener) => {
        order.push('subscribe')
        searchListeners.add(listener)
        return () => {
          order.push('unsubscribe')
          searchListeners.delete(listener)
        }
      })
  }
  const capture = {
    listCaptureSources: vi.fn().mockResolvedValue([
      { id: 'game', name: 'Synthetic game' },
      { id: 'next', name: 'Next game' }
    ]),
    selectCaptureSource: vi.fn().mockResolvedValue({ id: 'game', name: 'Synthetic game' }),
    notifyStableNicknameDetected: vi
      .fn<ObservationTestApi['notifyStableNicknameDetected']>()
      .mockImplementation(async (observation) => {
        const slots = currentSearch.slots.map((slot) => {
          const isObserved = slot.slot === observation.slot
          return isObserved
            ? searchSlot({
                slot: observation.slot,
                nickname: observation.nickname,
                observationRevision: observation.observationRevision
              })
            : slot
        })
        currentSearch = { ...currentSearch, revision: currentSearch.revision + 1, slots }
        return { ok: true, snapshot: currentSearch }
      })
  }
  const auth = {
    getAuthState: vi.fn().mockImplementation(async () => currentAuth),
    onAuthStateChanged: vi.fn().mockImplementation((listener: (snapshot: AuthSnapshot) => void) => {
      authListeners.add(listener)
      return () => authListeners.delete(listener)
    }),
    beginLogin: vi.fn(),
    cancelLogin: vi.fn(),
    retryAuth: vi.fn(),
    logout: vi.fn()
  }
  Object.defineProperty(window, 'api', { configurable: true, value: capture })
  Object.defineProperty(window, 'auth', { configurable: true, value: auth })
  Object.defineProperty(window, 'search', { configurable: true, value: search })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia }
  })
  media.worker.mockResolvedValue(resources.worker)
  media.crops.mockReturnValue([null, null, null, null])
  media.loop.mockImplementation(() => new Promise<void>(() => undefined))

  async function unmount(): Promise<void> {
    if (mounted) {
      mounted = false
      await act(async () => root.unmount())
      container.remove()
    }
  }
  cleanup.push(unmount)

  function button(label: string, within: ParentNode = container): HTMLButtonElement {
    const found = Array.from(within.querySelectorAll('button')).find((item) => {
      const hasLabel = item.textContent === label
      return hasLabel
    })
    expect(found, `화면 버튼 ${label}`).toBeDefined()
    return found as HTMLButtonElement
  }
  async function select(source = 'game'): Promise<void> {
    const select = container.querySelector('select')
    expect(select, 'source 선택').not.toBeNull()
    await act(async () => {
      select!.value = source
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  async function click(label: string): Promise<void> {
    await act(async () => button(label).click())
  }
  async function start(): Promise<void> {
    await select()
    await click('Start')
  }
  async function cycle(count = 1): Promise<void> {
    const loop = media.loop.mock.calls.at(-1)?.[0] as Loop | undefined
    expect(loop, '실제 capture의 OCR loop').toBeDefined()
    for (let index = 0; index < count; index += 1) {
      await act(async () => loop!.runCycle())
    }
  }
  async function emit(snapshot: SearchSnapshot): Promise<void> {
    currentSearch = snapshot
    await act(async () => {
      for (const listener of searchListeners) {
        listener(snapshot)
      }
    })
  }
  async function emitAuth(snapshot: AuthSnapshot): Promise<void> {
    currentAuth = snapshot
    await act(async () => {
      for (const listener of authListeners) {
        listener(snapshot)
      }
    })
  }
  return {
    container,
    search,
    capture,
    auth,
    resources,
    getDisplayMedia,
    order,
    mount: async () => {
      await act(async () => root.render(<App />))
    },
    unmount,
    button,
    select,
    click,
    start,
    cycle,
    emit,
    emitAuth,
    current: () => currentSearch,
    result: (): SearchCommandResult => ({ ok: true, snapshot: currentSearch })
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement
  ) {
    Object.defineProperty(this, 'videoWidth', { configurable: true, value: 1920 })
    Object.defineProperty(this, 'videoHeight', { configurable: true, value: 1080 })
    this.dispatchEvent(new Event('loadedmetadata'))
  })
})
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) {
    await dispose()
  }
  vi.restoreAllMocks()
})

export { media }
