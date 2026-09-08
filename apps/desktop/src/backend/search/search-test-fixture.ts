import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, expect, vi } from 'vitest'
import { createAuthCoordinator } from '../auth/coordinator'
import type { AuthClock, AuthCoordinator } from '../auth/types'
import { API_ORIGIN, REFRESH_0, createAuthHarness } from '../auth/auth-test-fixtures'
import { registerCaptureIpc, registerCaptureWindow } from '../capture/ipc-handler'
import type { SearchSnapshot } from '../../preload/common/types/search'

const electron = vi.hoisted(() => ({
  getSources: vi.fn(),
  handle: vi.fn(),
  removeHandler: vi.fn()
}))
vi.mock('electron', () => ({
  desktopCapturer: { getSources: electron.getSources },
  ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler }
}))

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type SearchConfiguration = { apiOrigin: string; fetch: typeof fetch; clock: AuthClock }
const disposeFixtures: Array<() => void> = []
const source = { id: 'window:search-fixture', name: 'Synthetic search window' }
const rendererUrl = 'file:///search-fixture/index.html'

export const candidate = {
  characterId: 'synthetic-character',
  characterName: '가나',
  serverId: 'cain',
  serverName: '카인',
  fame: 0
}

export function jsonResponse({
  body,
  status = 200,
  headers = {}
}: {
  body: unknown
  status?: number
  headers?: Record<string, string>
}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

export async function createSearchFixture(): Promise<{
  auth: AuthCoordinator
  harness: ReturnType<typeof createAuthHarness>
  fetchSearch: ReturnType<typeof vi.fn<typeof fetch>>
  captureId: string
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  observe: (input: {
    slot: number
    observationRevision: number
    nickname: string
  }) => Promise<unknown>
  read: () => Promise<SearchSnapshot>
  published: ReturnType<typeof vi.fn>
}> {
  electron.handle.mockClear()
  electron.getSources.mockResolvedValue([source])
  const harness = createAuthHarness()
  harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
  const auth = createAuthCoordinator(harness.dependencies)
  await auth.start()
  harness.http.refresh.mockClear()
  harness.http.me.mockClear()
  const fetchSearch = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => jsonResponse({ body: { rows: [] } }))
  const frame = { url: rendererUrl, isDestroyed: () => false }
  const published = vi.fn()
  const contents = {
    mainFrame: frame,
    isDestroyed: () => false,
    on: vi.fn(),
    send: published,
    session: { setDisplayMediaRequestHandler: vi.fn() }
  }
  const window = { webContents: contents, isDestroyed: () => false, on: vi.fn() }
  // 기존 공개 등록 함수에 추가할 main 전용 설정이다. 실제 core와 capture handler를 사용한다.
  const register: (auth: AuthCoordinator, configuration: SearchConfiguration) => () => void =
    registerCaptureIpc
  const dispose = register(auth, {
    apiOrigin: API_ORIGIN,
    fetch: fetchSearch,
    clock: harness.clock
  })
  disposeFixtures.push(dispose)
  registerCaptureWindow(window as unknown as BrowserWindow, rendererUrl)
  const handlers = new Map<string, Handler>()
  for (const [channel, handler] of electron.handle.mock.calls) {
    handlers.set(channel, handler)
  }
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)
    expect(handler, `등록된 ${channel} IPC`).toBeTypeOf('function')
    const hasHandler = handler != null
    if (!hasHandler) {
      throw new Error('Expected search IPC handler')
    }
    return handler(event, ...args)
  }
  const read = async (): Promise<SearchSnapshot> => {
    const result = await invoke('controlCharacterSearch', { action: 'read' })
    expect(result).toMatchObject({ ok: true, snapshot: expect.any(Object) })
    return (result as { snapshot: SearchSnapshot }).snapshot
  }

  await invoke('selectCaptureSource', source.id)
  const snapshot = auth.getSnapshot()
  await invoke('controlCharacterSearch', {
    action: 'begin',
    authRunId: snapshot.runId,
    authRevision: snapshot.revision
  })
  const begun = await read()
  expect(begun.captureId).toEqual(expect.any(String))
  const captureId = begun.captureId as string
  const observe = (input: {
    slot: number
    observationRevision: number
    nickname: string
  }): Promise<unknown> => invoke('notifyStableNicknameDetected', { captureId, ...input })

  return { auth, harness, fetchSearch, captureId, invoke, observe, read, published }
}

afterEach(() => {
  for (const dispose of disposeFixtures.splice(0)) {
    dispose()
  }
})
