import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

type Contents = {
  mainFrame: { url: string; detached: boolean; isDestroyed: () => boolean }
  isDestroyed: () => boolean
  on: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
}
type WindowDouble = { webContents: Contents; isDestroyed: () => boolean }
const fixture = vi.hoisted(() => ({
  windows: [] as WindowDouble[],
  generation: null as number | null,
  documentUrl: '',
  capture: vi.fn(() => vi.fn()),
  check: vi.fn(),
  request: vi.fn(),
  ready: undefined as Promise<void> | undefined
}))
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    setPath: vi.fn(),
    setName: vi.fn(),
    on: vi.fn(),
    exit: vi.fn(),
    quit: vi.fn(),
    whenReady: (): { then: (callback: () => Promise<void>) => Promise<void> } => ({
      then: (callback: () => Promise<void>) => {
        fixture.ready = Promise.resolve().then(callback)
        return fixture.ready
      }
    })
  },
  BrowserWindow: class {
    webContents = {
      mainFrame: { url: '', detached: false, isDestroyed: () => false },
      isDestroyed: () => false,
      session: {
        setPermissionCheckHandler: fixture.check,
        setPermissionRequestHandler: fixture.request
      },
      on: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
    isDestroyed = (): boolean => false
    on = vi.fn()
    show = vi.fn()
    destroy = vi.fn()
    constructor() {
      fixture.windows.push(this)
    }
    async loadFile(path: string): Promise<void> {
      this.webContents.mainFrame.url = pathToFileURL(path).href
    }
  },
  session: {
    defaultSession: {
      setPermissionCheckHandler: fixture.check,
      setPermissionRequestHandler: fixture.request,
      webRequest: { onBeforeRequest: vi.fn() }
    }
  },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  systemPreferences: { getMediaAccessStatus: () => 'granted' }
}))
vi.mock('./smoke', () => ({ smoke: vi.fn(), smokeStandaloneOcr: vi.fn() }))
vi.mock('../../src/backend/auth/coordinator', () => ({
  createAuthCoordinator: () => ({
    start: async () => undefined,
    captureGeneration: () => fixture.generation
  })
}))
vi.mock('../../src/backend/auth/ipc-handler', () => ({
  registerAuthIpc: (options: { documentUrl: string }) => {
    fixture.documentUrl = options.documentUrl
    return vi.fn()
  }
}))
vi.mock('../../src/backend/capture/ipc-handler', () => ({
  registerCaptureIpc: fixture.capture,
  registerCaptureWindow: vi.fn()
}))

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  fixture.windows = []
  fixture.generation = 0
  vi.stubEnv('LDB_AUTH_CAPTURE_PROFILE', join(tmpdir(), 'ldb-auth-capture-fixture-unit01'))
  vi.stubEnv('LDB_AUTH_CAPTURE_LAUNCHER_PID', String(process.ppid))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  await import('./main')
  await fixture.ready
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function request(
  changes: Record<string, unknown> = {},
  contents = fixture.windows[0].webContents,
  permission = 'media'
): boolean {
  const callback = vi.fn()
  const handler = fixture.request.mock.calls[0][0]
  handler(contents, permission, callback, {
    isMainFrame: true,
    requestingUrl: fixture.documentUrl,
    mediaTypes: [],
    ...changes
  })
  expect(callback).toHaveBeenCalledOnce()
  return callback.mock.calls[0][0]
}

it('현재 main 권한이 있는 정확한 fixture document의 존재하는 빈 mediaTypes만 허용한다', () => {
  expect(request()).toBe(true)
})
it('등록 후의 인증 이탈과 새 signedIn도 현재 main 권한으로 판단한다', () => {
  expect(request()).toBe(true)
  fixture.generation = null
  expect(request()).toBe(false)
  fixture.generation = 2
  expect(request()).toBe(true)
})
it.each([undefined, null, {}, '', 'video', ['video'], ['audio'], ['video', 'audio']])(
  '잘못되거나 비어 있지 않은 mediaTypes %j는 거절한다',
  (mediaTypes) => {
    expect(request({ mediaTypes })).toBe(false)
  }
)
it('mediaTypes field 누락은 거절한다', () => {
  const callback = vi.fn()
  fixture.request.mock.calls[0][0](fixture.windows[0].webContents, 'media', callback, {
    isMainFrame: true,
    requestingUrl: fixture.documentUrl
  })
  expect(callback).toHaveBeenCalledExactlyOnceWith(false)
})
it.each(['display-capture', 'notifications', 'geolocation'])(
  '%s 권한을 포괄 허용하지 않는다',
  (permission) => {
    expect(request({}, fixture.windows[0].webContents, permission)).toBe(false)
  }
)
it('합성 source 창도 등록된 auth/capture renderer가 아니면 거절한다', () => {
  expect(request({}, fixture.windows[1].webContents)).toBe(false)
})
it.each([
  { isMainFrame: false },
  { isMainFrame: undefined },
  { requestingUrl: 'about:blank' },
  { requestingUrl: undefined }
])('다른 frame/document %j는 거절한다', (changes) => {
  expect(request(changes)).toBe(false)
})
it('현재 document가 바뀌면 과거 requestingUrl로 허용하지 않는다', () => {
  fixture.windows[0].webContents.mainFrame.url = 'about:blank'
  expect(request()).toBe(false)
})
it('현재 main이 signedIn이 아니면 renderer 요청으로 권한을 만들지 않는다', () => {
  fixture.generation = null
  expect(request({ signedIn: true, revision: 999 })).toBe(false)
})
it.each(['window', 'contents', 'frame'])('종료된 %s에서는 허용하지 않는다', (target) => {
  const window = fixture.windows[0]
  const isWindow = target === 'window'
  const isContents = target === 'contents'
  if (isWindow) window.isDestroyed = () => true
  else if (isContents) window.webContents.isDestroyed = () => true
  else window.webContents.mainFrame.detached = true
  expect(request()).toBe(false)
})
it('permission check는 모든 mediaType에서 계속 거절한다', () => {
  const check = fixture.check.mock.calls[0][0]
  for (const mediaType of ['unknown', 'video', 'audio']) {
    expect(
      check(fixture.windows[0].webContents, 'media', 'file://', {
        isMainFrame: true,
        mediaType,
        requestingUrl: fixture.documentUrl
      })
    ).toBe(false)
  }
})

it('명시적 deny-media 모드는 승인된 정상 요청도 거절한다', async () => {
  const originalArgv = process.argv
  try {
    process.argv = [...originalArgv, '--deny-media']
    vi.resetModules()
    fixture.windows = []
    fixture.request.mockClear()
    await import('./main')
    await fixture.ready
    expect(request()).toBe(false)
  } finally {
    process.argv = originalArgv
  }
})

it('main fixture는 동일 coordinator와 clock 및 외부 네트워크 없는 고정 검색 transport를 연결한다', async () => {
  expect(fixture.capture).toHaveBeenCalledOnce()
  const args = fixture.capture.mock.calls[0] as unknown as [
    { captureGeneration: () => number | null },
    { apiOrigin: string; clock: { read: () => { monotonicMs: number } }; fetch: typeof fetch }
  ]
  const [coordinator, runtime] = args
  expect(coordinator.captureGeneration()).toBe(0)
  expect(runtime, 'main 검색 runtime 구성').toBeDefined()
  expect(runtime.apiOrigin).toBe('https://api.example.test')
  expect(runtime.clock.read().monotonicMs).toBeGreaterThanOrEqual(0)
  expect(runtime.fetch).toBeTypeOf('function')
  expect(runtime.fetch).not.toBe(globalThis.fetch)
  const response = await runtime.fetch(
    new Request('https://api.example.test/characters?characterName=ALICE', {
      headers: { authorization: 'Bearer synthetic.payload.signature' }
    })
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ rows: expect.any(Array) })
  await expect(runtime.fetch(new Request('https://outside.example.test/'))).rejects.toThrow()
})
