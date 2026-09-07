import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  constructWindow: vi.fn(),
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  registerWindow: vi.fn(),
  bootstrap: undefined as Promise<void> | undefined
}))
vi.mock('electron', () => ({
  app: {
    whenReady: () => ({
      then: (callback: () => void): Promise<void> => {
        mocks.bootstrap = Promise.resolve().then(callback)
        return mocks.bootstrap.catch(() => undefined)
      }
    }),
    on: vi.fn()
  },
  BrowserWindow: class {
    constructor() {
      mocks.constructWindow()
    }
    on = vi.fn()
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() }
    loadURL = mocks.loadURL
    loadFile = mocks.loadFile
  }
}))
vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: true }
}))
vi.mock('./capture/ipc-handler', () => ({
  registerCaptureIpc: vi.fn(),
  registerCaptureWindow: mocks.registerWindow
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})
afterEach(() => vi.unstubAllEnvs())

it.each([
  'https://example.test/',
  'data:text/html,synthetic',
  'javascript:void(0)',
  'http://synthetic@localhost:5173/',
  'http://localhost.example.test:5173/',
  'http://2130706433:5173/',
  'http://%6cocalhost:5173/',
  ' http://localhost:5173/'
])('local dev 경계를 벗어난 %s는 window 생성 전에 거절한다', async (url) => {
  vi.stubEnv('ELECTRON_RENDERER_URL', url)
  await import('./main')
  await expect(mocks.bootstrap).rejects.toThrow()
  expect(mocks.constructWindow).not.toHaveBeenCalled()
  expect(mocks.registerWindow).not.toHaveBeenCalled()
  expect(mocks.loadURL).not.toHaveBeenCalled()
})

it.each([
  ['http://localhost:5173', 'http://localhost:5173/'],
  ['http://127.0.0.1:5173/', 'http://127.0.0.1:5173/'],
  ['https://[::1]:5173/local.html', 'https://[::1]:5173/local.html']
])('검증한 local URL %s 하나만 등록하고 load한다', async (url, expected) => {
  vi.stubEnv('ELECTRON_RENDERER_URL', url)
  await import('./main')
  await mocks.bootstrap
  expect(mocks.loadURL).toHaveBeenCalledExactlyOnceWith(expected)
  expect(mocks.registerWindow).toHaveBeenCalledWith(expect.anything(), expected)
})
