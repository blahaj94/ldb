import { beforeEach, expect, it, vi } from 'vitest'
import type { SearchControl } from '../common/types/search'
import {
  CAPTURE_ID,
  REQUEST_ID,
  SEARCH_RUN,
  invalidSearchSnapshots,
  searchRow,
  searchSlot,
  searchSnapshot,
  withSearchSlot,
  type SearchTestApi,
  type ObservationTestApi
} from './search-test-fixture'

const renderer = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  expose: vi.fn<(key: string, api: unknown) => void>()
}))
vi.mock('electron', () => ({
  ipcRenderer: renderer,
  contextBridge: { exposeInMainWorld: renderer.expose }
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  renderer.invoke.mockResolvedValue({ ok: true, snapshot: searchSnapshot() })
})

async function exposedSearch(): Promise<{ search: SearchTestApi; capture: ObservationTestApi }> {
  await import('../index')
  const exposed = new Map(renderer.expose.mock.calls)
  expect(exposed.get('search'), '검색 전용 preload API').toBeDefined()
  return {
    search: exposed.get('search') as SearchTestApi,
    capture: exposed.get('api') as ObservationTestApi
  }
}

it('검색 feature는 제어 invoke와 단일 event만 노출하고 기존 notify를 확장한다', async () => {
  const { search, capture } = await exposedSearch()
  expect(Object.keys(search).sort()).toEqual(['controlCharacterSearch', 'onCharacterSearchChanged'])
  const controls: SearchControl[] = [
    { action: 'read' },
    { action: 'begin', authRunId: SEARCH_RUN, authRevision: 1 },
    { action: 'end', captureId: CAPTURE_ID },
    { action: 'clear', captureId: CAPTURE_ID, slot: 2, observationRevision: 3 },
    { action: 'retry', captureId: CAPTURE_ID, slot: 2, requestId: REQUEST_ID }
  ]
  for (const control of controls) {
    await search.controlCharacterSearch(control)
  }
  const observation = { captureId: CAPTURE_ID, slot: 2, observationRevision: 4, nickname: '가나' }
  await capture.notifyStableNicknameDetected(observation)
  expect(renderer.invoke.mock.calls).toEqual([
    ...controls.map((control) => ['controlCharacterSearch', control]),
    ['notifyStableNicknameDetected', observation]
  ])
})

it('event는 Electron event를 제거하고 각 wrapper만 해제한다', async () => {
  const { search } = await exposedSearch()
  const first = vi.fn()
  const second = vi.fn()
  const unsubscribe = search.onCharacterSearchChanged(first)
  search.onCharacterSearchChanged(second)
  const [[channel, firstWrapper], [, secondWrapper]] = renderer.on.mock.calls
  const snapshot = searchSnapshot()
  firstWrapper({ sender: 'private' }, snapshot)
  secondWrapper({ sender: 'private' }, snapshot)
  unsubscribe()
  expect(channel).toBe('characterSearchChanged')
  expect(first).toHaveBeenCalledExactlyOnceWith(snapshot)
  expect(second).toHaveBeenCalledExactlyOnceWith(snapshot)
  expect(firstWrapper).not.toBe(secondWrapper)
  expect(renderer.removeListener).toHaveBeenCalledExactlyOnceWith(channel, firstWrapper)
})

it.each(invalidSearchSnapshots)(
  '잘못된 %s DTO는 invoke와 event에서 renderer로 넘기지 않는다',
  async (_name, invalid) => {
    const capture = (await import('./capture')) as unknown as ObservationTestApi
    renderer.invoke.mockResolvedValue({ ok: true, snapshot: invalid() })
    await expect(
      capture.notifyStableNicknameDetected({
        captureId: CAPTURE_ID,
        slot: 0,
        observationRevision: 1,
        nickname: '가나'
      })
    ).rejects.toThrow()
    const { search } = await exposedSearch()
    await expect(search.controlCharacterSearch({ action: 'read' })).rejects.toThrow()
    const listener = vi.fn()
    search.onCharacterSearchChanged(listener)
    renderer.on.mock.calls[0][1]({}, invalid())
    expect(listener).not.toHaveBeenCalled()
  }
)

it.each([
  { ok: true, error: { code: 'SEARCH_BUSY' }, snapshot: searchSnapshot() },
  { ok: false, error: { code: 'UNKNOWN' }, snapshot: searchSnapshot() },
  { ok: false, error: { code: 'SEARCH_BUSY', message: 'private' }, snapshot: searchSnapshot() },
  { ok: true, snapshot: searchSnapshot(), private: true }
])('명령 결과의 exact shape도 검사한다: %j', async (invalid) => {
  const { search } = await exposedSearch()
  renderer.invoke.mockResolvedValue(invalid)
  await expect(search.controlCharacterSearch({ action: 'read' })).rejects.toThrow()
})

it('승인된 상태·nullable 값과 후보 순서를 보존한다', async () => {
  const { search } = await exposedSearch()
  const rows = [searchRow, { ...searchRow, characterId: 'second', serverName: null, fame: -1.5 }]
  const slots = [
    searchSlot(),
    searchSlot({ state: 'success', rows }),
    searchSlot({ state: 'empty' }),
    searchSlot({
      state: 'failure',
      error: { code: 'SEARCH_AUTH_NOT_READY', retryAfterSeconds: null }
    }),
    searchSlot({ state: 'failure', error: { code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: 0 } })
  ]
  for (const slot of slots) {
    const result = { ok: true, snapshot: withSearchSlot(slot) }
    renderer.invoke.mockResolvedValueOnce(result)
    expect(await search.controlCharacterSearch({ action: 'read' })).toEqual(result)
  }
})
