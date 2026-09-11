import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  constructWindow: vi.fn(),
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  registerWindow: vi.fn(),
  permissionCheck: vi.fn(),
  permissionRequest: vi.fn(),
  registerCapture: vi.fn(),
  bootstrap: undefined as Promise<void> | undefined,
  createIngress: vi.fn(),
  attachIngress: vi.fn(),
  attachAfterStart: vi.fn(),
  isOrdinarySecondInstance: vi.fn(() => true),
  disposeIngress: vi.fn(),
  createEffects: vi.fn(),
  bootstrapAuth: vi.fn(),
  applyProfile: vi.fn(
    (
      application: {
        setPath(name: 'userData', path: string): void
        getPath(name: 'userData'): string
        setName(name: string): void
        setAppUserModelId(id: string): void
      },
      config: { userDataPath: string; appIdentity: string }
    ) => {
      application.setPath('userData', config.userDataPath)
      application.getPath('userData')
      application.setName(config.appIdentity)
      application.setAppUserModelId(config.appIdentity)
      return config
    }
  ),
  registerAuth: vi.fn(),
  setPath: vi.fn(),
  getPath: vi.fn(),
  setName: vi.fn(),
  setAppUserModelId: vi.fn(),
  exit: vi.fn(),
  appOn: vi.fn(),
  appRemoveListener: vi.fn(),
  windows: [] as unknown[],
  coordinator: {
    captureGeneration: vi.fn(() => 1),
    handleReturnUrl: vi.fn()
  },
  runtime: undefined as
    | {
        coordinator: typeof mocks.coordinator
        apiOrigin: string
        searchClock: object
        start: ReturnType<typeof vi.fn>
      }
    | undefined
}))
vi.mock('electron', () => ({
  session: {
    defaultSession: {
      setPermissionCheckHandler: mocks.permissionCheck,
      setPermissionRequestHandler: mocks.permissionRequest
    }
  },
  app: {
    whenReady: () => ({
      then: (callback: () => void | Promise<void>): Promise<void> => {
        mocks.bootstrap = Promise.resolve().then(callback)
        return mocks.bootstrap.catch(() => undefined)
      }
    }),
    on: mocks.appOn,
    removeListener: mocks.appRemoveListener,
    requestSingleInstanceLock: vi.fn(() => true),
    setPath: mocks.setPath,
    getPath: mocks.getPath,
    setName: mocks.setName,
    setAppUserModelId: mocks.setAppUserModelId,
    exit: mocks.exit,
    quit: vi.fn()
  },
  BrowserWindow: class {
    static getAllWindows = vi.fn(() => mocks.windows)

    constructor() {
      mocks.constructWindow()
      mocks.windows.push(this)
    }
    isDestroyed = vi.fn(() => false)
    on = vi.fn()
    webContents = {
      mainFrame: { url: '', detached: false, isDestroyed: vi.fn(() => false) },
      isDestroyed: vi.fn(() => false),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn()
    }
    loadURL = mocks.loadURL
    loadFile = mocks.loadFile
    isMinimized = vi.fn(() => false)
    restore = vi.fn()
    show = vi.fn()
    focus = vi.fn()
  }
}))
vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: true }
}))
vi.mock('./capture/ipc-handler', () => ({
  registerCaptureIpc: mocks.registerCapture,
  registerCaptureWindow: mocks.registerWindow
}))
vi.mock('./auth/protocol-ingress', () => ({
  createProtocolIngress: mocks.createIngress,
  attachProtocolIngressAfterStart: mocks.attachAfterStart,
  isOrdinarySecondInstanceInvocation: mocks.isOrdinarySecondInstance
}))
vi.mock('./auth/runtime-effects', () => ({
  createAuthRuntimeEffects: mocks.createEffects
}))
vi.mock('./auth/runtime-config', async () => {
  const actual =
    await vi.importActual<typeof import('./auth/runtime-config')>('./auth/runtime-config')
  return { ...actual, applyAuthRuntimeProfile: mocks.applyProfile }
})
vi.mock('./auth/bootstrap', () => ({
  bootstrapAuthRuntime: mocks.bootstrapAuth
}))
vi.mock('./auth/ipc-handler', () => ({
  registerAuthIpc: mocks.registerAuth
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.windows = []
  mocks.createIngress.mockReturnValue({
    ownsInstance: true,
    attach: mocks.attachIngress,
    dispose: mocks.disposeIngress
  })
  mocks.attachAfterStart.mockImplementation((_ingress, _start, dispatch, _isActive, activate) => {
    mocks.attachIngress(dispatch, activate)
    return vi.fn()
  })
  mocks.coordinator.handleReturnUrl.mockImplementation(
    async (_raw: unknown, onClaimed?: () => void) => {
      onClaimed?.()
    }
  )
  mocks.runtime = {
    coordinator: mocks.coordinator,
    apiOrigin: 'https://api.synthetic.test',
    searchClock: {},
    start: vi.fn(async () => undefined)
  }
  mocks.createEffects.mockReturnValue({})
  mocks.getPath.mockImplementation(() => process.env['LDB_AUTH_USER_DATA_PATH'] ?? '')
  mocks.bootstrapAuth.mockResolvedValue(mocks.runtime)
  mocks.registerAuth.mockReturnValue(vi.fn())
})
afterEach(() => vi.unstubAllEnvs())

function stubTrustedRuntimeEnvironment(): void {
  vi.stubEnv('LDB_AUTH_API_ORIGIN', 'https://api.synthetic.test')
  vi.stubEnv('LDB_AUTH_RETURN_TARGET', 'ldb-synthetic://auth/return')
  vi.stubEnv('LDB_AUTH_ENVIRONMENT', 'test')
  vi.stubEnv('LDB_AUTH_PROVIDERS', 'google')
  vi.stubEnv('LDB_AUTH_APP_IDENTITY', 'com.synthetic.ldb')
  vi.stubEnv('LDB_AUTH_USER_DATA_PATH', '/synthetic/ldb-test-profile')
}

function deferred<Value>(): {
  promise: Promise<Value>
  resolve(value: Value): void
  reject(error: unknown): void
} {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

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

it('인증 미구성 기본 entry는 legacy를 포함한 media permission을 명시적으로 거절한다', async () => {
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
  await import('./main')
  await mocks.bootstrap
  expect(mocks.permissionCheck).toHaveBeenCalledOnce()
  expect(mocks.permissionRequest).toHaveBeenCalledOnce()
  const check = mocks.permissionCheck.mock.calls[0][0]
  const request = mocks.permissionRequest.mock.calls[0][0]
  expect(check(null, 'media', 'file://', { mediaType: 'unknown', isMainFrame: true })).toBe(false)
  const callback = vi.fn()
  request({}, 'media', callback, { mediaTypes: [], isMainFrame: true })
  expect(callback).toHaveBeenCalledExactlyOnceWith(false)
})

it('완전한 trusted 설정에서 동일 document와 auth/search runtime을 제품에 연결한다', async () => {
  vi.stubEnv('LDB_AUTH_API_ORIGIN', 'https://api.synthetic.test')
  vi.stubEnv('LDB_AUTH_RETURN_TARGET', 'ldb-synthetic://auth/return')
  vi.stubEnv('LDB_AUTH_ENVIRONMENT', 'test')
  vi.stubEnv('LDB_AUTH_PROVIDERS', 'google')
  vi.stubEnv('LDB_AUTH_APP_IDENTITY', 'com.synthetic.ldb')
  vi.stubEnv('LDB_AUTH_USER_DATA_PATH', '/synthetic/ldb-test-profile')
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')

  await import('./main')
  await mocks.bootstrap

  expect(mocks.createIngress).toHaveBeenCalledExactlyOnceWith({
    app: expect.anything(),
    argv: process.argv,
    returnTarget: 'ldb-synthetic://auth/return'
  })
  expect(mocks.createEffects).toHaveBeenCalledOnce()
  expect(mocks.bootstrapAuth).toHaveBeenCalledOnce()
  expect(mocks.setPath).toHaveBeenCalledExactlyOnceWith('userData', '/synthetic/ldb-test-profile')
  expect(mocks.setName).toHaveBeenCalledExactlyOnceWith('com.synthetic.ldb')
  expect(mocks.setAppUserModelId).toHaveBeenCalledExactlyOnceWith('com.synthetic.ldb')
  expect(mocks.registerAuth).toHaveBeenCalledExactlyOnceWith({
    coordinator: mocks.coordinator,
    getWindow: expect.any(Function),
    documentUrl: 'http://localhost:5173/'
  })
  expect(mocks.registerCapture).toHaveBeenCalledExactlyOnceWith(mocks.coordinator, {
    apiOrigin: 'https://api.synthetic.test',
    clock: mocks.runtime?.searchClock
  })
  expect(mocks.registerWindow).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    'http://localhost:5173/'
  )
  expect(mocks.attachIngress).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    expect.any(Function)
  )
  expect(mocks.runtime?.start).toHaveBeenCalledOnce()
  expect(mocks.runtime?.start.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.registerAuth.mock.invocationCallOrder[0]
  )
})

it('packaged document의 closed 정리 뒤 activate에서 같은 runtime과 IPC를 다시 연결한다', async () => {
  stubTrustedRuntimeEnvironment()
  const expectedDocumentUrl = pathToFileURL(join(__dirname, '../frontend/index.html')).href

  await import('./main')
  await mocks.bootstrap
  const firstWindow = mocks.windows[0] as { on: ReturnType<typeof vi.fn> }
  const closedRegistration = firstWindow.on.mock.calls.find(([event]) => event === 'closed')
  expect(closedRegistration).toBeDefined()
  const closeWindow = closedRegistration?.[1] as () => void
  const firstAuthDisposer = mocks.registerAuth.mock.results[0]?.value as ReturnType<typeof vi.fn>

  closeWindow()
  mocks.windows = []
  const activateRegistration = mocks.appOn.mock.calls.find(([event]) => event === 'activate')
  expect(activateRegistration).toBeDefined()
  const activate = activateRegistration?.[1] as () => void
  activate()

  expect(firstAuthDisposer).toHaveBeenCalledOnce()
  expect(mocks.constructWindow).toHaveBeenCalledTimes(2)
  expect(mocks.registerAuth).toHaveBeenCalledTimes(2)
  expect(mocks.registerWindow).toHaveBeenNthCalledWith(1, expect.anything(), expectedDocumentUrl)
  expect(mocks.registerWindow).toHaveBeenNthCalledWith(2, expect.anything(), expectedDocumentUrl)
  expect(mocks.loadFile).toHaveBeenCalledTimes(2)
  expect(mocks.loadFile).toHaveBeenNthCalledWith(1, join(__dirname, '../frontend/index.html'))
  expect(mocks.loadFile).toHaveBeenNthCalledWith(2, join(__dirname, '../frontend/index.html'))
})

it('profile owner의 activate 재구성 예외는 event 밖으로 던지지 않고 nonzero로 종료한다', async () => {
  stubTrustedRuntimeEnvironment()

  await import('./main')
  await mocks.bootstrap
  mocks.windows = []
  mocks.constructWindow.mockImplementationOnce(() => {
    throw new Error('Synthetic activate construction failure')
  })
  const registration = mocks.appOn.mock.calls.find(([event]) => event === 'activate')
  expect(registration).toBeDefined()
  const activate = registration?.[1] as () => void

  expect(() => activate()).not.toThrow()
  expect(mocks.disposeIngress).toHaveBeenCalledOnce()
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1)
})

it('does not activate product auth for the unresolved Discord provider gate', async () => {
  vi.stubEnv('LDB_AUTH_API_ORIGIN', 'https://api.synthetic.test')
  vi.stubEnv('LDB_AUTH_RETURN_TARGET', 'ldb-synthetic://auth/return')
  vi.stubEnv('LDB_AUTH_ENVIRONMENT', 'test')
  vi.stubEnv('LDB_AUTH_PROVIDERS', 'discord')
  vi.stubEnv('LDB_AUTH_APP_IDENTITY', 'com.synthetic.ldb')
  vi.stubEnv('LDB_AUTH_USER_DATA_PATH', '/synthetic/ldb-test-profile')

  await import('./main')
  await mocks.bootstrap

  expect(mocks.createIngress).not.toHaveBeenCalled()
  expect(mocks.createEffects).not.toHaveBeenCalled()
  expect(mocks.bootstrapAuth).not.toHaveBeenCalled()
  expect(mocks.registerAuth).not.toHaveBeenCalled()
  expect(mocks.setPath).not.toHaveBeenCalled()
})

it('profile 적용이 시작된 뒤 실패하면 부분 적용된 userData로 시작하지 않는다', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ldb-main-profile-')))
  const userDataPath = join(root, 'profile')
  fs.mkdirSync(userDataPath, { mode: 0o700 })
  vi.stubEnv('LDB_AUTH_API_ORIGIN', 'https://api.synthetic.test')
  vi.stubEnv('LDB_AUTH_RETURN_TARGET', 'ldb-synthetic://auth/return')
  vi.stubEnv('LDB_AUTH_ENVIRONMENT', 'test')
  vi.stubEnv('LDB_AUTH_PROVIDERS', 'google')
  vi.stubEnv('LDB_AUTH_APP_IDENTITY', 'com.synthetic.ldb')
  vi.stubEnv('LDB_AUTH_USER_DATA_PATH', userDataPath)
  const runtimeConfigModule = await import('./auth/runtime-config')
  const actual =
    await vi.importActual<typeof import('./auth/runtime-config')>('./auth/runtime-config')
  mocks.applyProfile.mockImplementationOnce((application, config) => {
    try {
      actual.applyAuthRuntimeProfile(application, config)
    } catch {
      throw new runtimeConfigModule.AuthRuntimeProfileApplicationFailure()
    }
  })
  mocks.setName.mockImplementationOnce(() => {
    throw new Error('Synthetic app identity failure')
  })

  try {
    await import('./main')
    await mocks.bootstrap

    expect(mocks.setPath).toHaveBeenCalledExactlyOnceWith('userData', userDataPath)
    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(mocks.createIngress).not.toHaveBeenCalled()
    expect(mocks.bootstrapAuth).not.toHaveBeenCalled()
    expect(mocks.constructWindow).not.toHaveBeenCalled()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it('profile 준비 실패는 Electron 전역값과 lock을 건드리지 않고 비인증 window로 전환한다', async () => {
  stubTrustedRuntimeEnvironment()
  mocks.applyProfile.mockImplementationOnce(() => {
    throw new Error('Synthetic profile preparation failure')
  })

  await import('./main')
  await mocks.bootstrap

  expect(mocks.setPath).not.toHaveBeenCalled()
  expect(mocks.createIngress).not.toHaveBeenCalled()
  expect(mocks.bootstrapAuth).not.toHaveBeenCalled()
  expect(mocks.exit).not.toHaveBeenCalled()
  expect(mocks.constructWindow).toHaveBeenCalledOnce()
})

it('single-instance loser는 auth/store/window 초기화 없이 종료한다', async () => {
  vi.stubEnv('LDB_AUTH_API_ORIGIN', 'https://api.synthetic.test')
  vi.stubEnv('LDB_AUTH_RETURN_TARGET', 'ldb-synthetic://auth/return')
  vi.stubEnv('LDB_AUTH_ENVIRONMENT', 'test')
  vi.stubEnv('LDB_AUTH_PROVIDERS', 'google')
  vi.stubEnv('LDB_AUTH_APP_IDENTITY', 'com.synthetic.ldb')
  vi.stubEnv('LDB_AUTH_USER_DATA_PATH', '/synthetic/ldb-test-profile')
  mocks.createIngress.mockReturnValue({
    ownsInstance: false,
    attach: mocks.attachIngress,
    dispose: mocks.disposeIngress
  })

  await import('./main')
  await mocks.bootstrap

  expect(mocks.createEffects).not.toHaveBeenCalled()
  expect(mocks.bootstrapAuth).not.toHaveBeenCalled()
  expect(mocks.registerAuth).not.toHaveBeenCalled()
  expect(mocks.registerWindow).not.toHaveBeenCalled()
  expect(mocks.constructWindow).not.toHaveBeenCalled()
})

it('profile owner의 notice 실패는 ingress를 닫고 같은 owner의 비인증 window로 전환한다', async () => {
  stubTrustedRuntimeEnvironment()
  mocks.bootstrapAuth.mockResolvedValueOnce(null)

  await import('./main')
  await mocks.bootstrap

  expect(mocks.disposeIngress).toHaveBeenCalledOnce()
  expect(mocks.exit).not.toHaveBeenCalled()
  expect(mocks.registerAuth).not.toHaveBeenCalled()
  expect(mocks.constructWindow).toHaveBeenCalledOnce()
})

it('notice 실패 fallback은 일반 second-instance만 활성화하고 protocol-like argv는 무시한다', async () => {
  stubTrustedRuntimeEnvironment()
  mocks.bootstrapAuth.mockResolvedValueOnce(null)

  await import('./main')
  await mocks.bootstrap
  const registration = mocks.appOn.mock.calls.find(([event]) => event === 'second-instance')
  expect(registration).toBeDefined()
  const secondInstance = registration?.[1] as (
    event: unknown,
    commandLine: readonly string[],
    workingDirectory: string
  ) => void
  const window = mocks.windows[0] as {
    show: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
  }

  secondInstance({}, ['electron', '--new-window'], '/tmp')
  expect(window.show).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()

  mocks.isOrdinarySecondInstance.mockReturnValueOnce(false)
  secondInstance({}, ['electron', 'ldb-synthetic://auth/return?code=short'], '/tmp')
  expect(window.show).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
  expect(mocks.isOrdinarySecondInstance).toHaveBeenLastCalledWith(
    ['electron', 'ldb-synthetic://auth/return?code=short'],
    'ldb-synthetic://auth/return'
  )
})

it.each([
  [
    'runtime effect 생성',
    () =>
      mocks.createEffects.mockImplementationOnce(() => {
        throw new Error('Synthetic runtime effect construction failure')
      })
  ],
  [
    'bootstrap 구성',
    () =>
      mocks.bootstrapAuth.mockRejectedValueOnce(
        new Error('Synthetic auth bootstrap construction failure')
      )
  ]
] as const)(
  'profile owner의 예상 밖 %s 실패는 ingress를 닫고 nonzero로 종료한다',
  async (_name, fail) => {
    stubTrustedRuntimeEnvironment()
    fail()

    await import('./main')
    await mocks.bootstrap

    expect(mocks.disposeIngress).toHaveBeenCalledOnce()
    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(mocks.registerCapture).not.toHaveBeenCalled()
    expect(mocks.constructWindow).not.toHaveBeenCalled()
  }
)

it('notice 대기 중 quit은 dependency, IPC, window와 restore를 뒤늦게 시작하지 않는다', async () => {
  stubTrustedRuntimeEnvironment()
  const pendingBootstrap = deferred<typeof mocks.runtime>()
  mocks.bootstrapAuth.mockReturnValueOnce(pendingBootstrap.promise)

  await import('./main')
  await vi.waitFor(() => expect(mocks.bootstrapAuth).toHaveBeenCalledOnce())
  const beforeQuitRegistration = mocks.appOn.mock.calls.find(([event]) => event === 'before-quit')
  expect(beforeQuitRegistration).toBeDefined()
  const beforeQuit = beforeQuitRegistration?.[1] as () => void

  beforeQuit()
  pendingBootstrap.resolve(mocks.runtime)
  await mocks.bootstrap

  expect(mocks.disposeIngress).toHaveBeenCalledOnce()
  expect(mocks.registerCapture).not.toHaveBeenCalled()
  expect(mocks.registerAuth).not.toHaveBeenCalled()
  expect(mocks.constructWindow).not.toHaveBeenCalled()
  expect(mocks.runtime?.start).not.toHaveBeenCalled()
})

it('profile owner의 예상 밖 restore rejection은 ingress를 닫고 nonzero로 종료한다', async () => {
  stubTrustedRuntimeEnvironment()
  mocks.runtime!.start = vi.fn(async () => {
    throw new Error('Synthetic unexpected restore failure')
  })

  await import('./main')
  await mocks.bootstrap
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1))

  expect(mocks.disposeIngress).toHaveBeenCalledOnce()
})

it('정상 quit 뒤의 늦은 restore rejection은 nonzero 종료로 바꾸지 않는다', async () => {
  stubTrustedRuntimeEnvironment()
  const pendingStart = deferred<void>()
  mocks.runtime!.start = vi.fn(() => pendingStart.promise)

  await import('./main')
  await mocks.bootstrap
  const beforeQuitRegistration = mocks.appOn.mock.calls.find(([event]) => event === 'before-quit')
  expect(beforeQuitRegistration).toBeDefined()
  const beforeQuit = beforeQuitRegistration?.[1] as () => void

  beforeQuit()
  pendingStart.reject(new Error('Synthetic late restore failure'))
  await pendingStart.promise.catch(() => undefined)
  await Promise.resolve()

  expect(mocks.disposeIngress).toHaveBeenCalledOnce()
  expect(mocks.exit).not.toHaveBeenCalled()
})

it('profile owner의 post-bootstrap composition 예외는 ingress를 닫고 nonzero로 종료한다', async () => {
  stubTrustedRuntimeEnvironment()
  mocks.registerCapture.mockImplementationOnce(() => {
    throw new Error('Synthetic capture composition failure')
  })

  await import('./main')
  await mocks.bootstrap

  expect(mocks.disposeIngress).toHaveBeenCalledOnce()
  expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(mocks.constructWindow).not.toHaveBeenCalled()
  expect(mocks.runtime?.start).not.toHaveBeenCalled()
})

it('URL 없는 second-instance는 기존 창을 표시하고 focus한다', async () => {
  vi.stubEnv('LDB_AUTH_API_ORIGIN', 'https://api.synthetic.test')
  vi.stubEnv('LDB_AUTH_RETURN_TARGET', 'ldb-synthetic://auth/return')
  vi.stubEnv('LDB_AUTH_ENVIRONMENT', 'test')
  vi.stubEnv('LDB_AUTH_PROVIDERS', 'google')
  vi.stubEnv('LDB_AUTH_APP_IDENTITY', 'com.synthetic.ldb')
  vi.stubEnv('LDB_AUTH_USER_DATA_PATH', '/synthetic/ldb-test-profile')

  await import('./main')
  await mocks.bootstrap
  const activate = mocks.attachIngress.mock.calls[0][1] as () => void
  expect(activate).toBeTypeOf('function')
  const window = mocks.windows[0] as {
    show: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
  }

  activate()

  expect(window.show).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
})

it('URL 없는 second-instance는 최소화된 기존 창을 복원한 뒤 표시하고 focus한다', async () => {
  stubTrustedRuntimeEnvironment()

  await import('./main')
  await mocks.bootstrap
  const activate = mocks.attachIngress.mock.calls[0][1] as () => void
  expect(activate).toBeTypeOf('function')
  const window = mocks.windows[0] as {
    isMinimized: ReturnType<typeof vi.fn>
    restore: ReturnType<typeof vi.fn>
    show: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
  }
  window.isMinimized.mockReturnValue(true)

  activate()

  expect(window.restore).toHaveBeenCalledOnce()
  expect(window.show).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
  expect(window.restore.mock.invocationCallOrder[0]).toBeLessThan(
    window.show.mock.invocationCallOrder[0]
  )
})

it('일반 second-instance의 window 활성화 실패를 Electron event 경계 밖으로 던지지 않는다', async () => {
  stubTrustedRuntimeEnvironment()

  await import('./main')
  await mocks.bootstrap
  const activate = mocks.attachIngress.mock.calls[0][1] as () => void
  expect(activate).toBeTypeOf('function')
  const window = mocks.windows[0] as { show: ReturnType<typeof vi.fn> }
  window.show.mockImplementationOnce(() => {
    throw new Error('Synthetic persistent window activation failure')
  })

  expect(() => activate()).not.toThrow()
})

it('actual ingress 하나가 valid callback을 한 번 시작하고 window 예외를 회수한다', async () => {
  stubTrustedRuntimeEnvironment()
  const actualProtocol =
    await vi.importActual<typeof import('./auth/protocol-ingress')>('./auth/protocol-ingress')
  mocks.createIngress.mockImplementationOnce(actualProtocol.createProtocolIngress)
  mocks.attachAfterStart.mockImplementationOnce(actualProtocol.attachProtocolIngressAfterStart)

  await import('./main')
  await mocks.bootstrap
  const secondInstanceListeners = mocks.appOn.mock.calls
    .filter(([event]) => event === 'second-instance')
    .map(([, listener]) => listener as (event: unknown, commandLine: string[], cwd: string) => void)
  expect(secondInstanceListeners).toHaveLength(1)
  const window = mocks.windows[0] as { show: ReturnType<typeof vi.fn> }
  window.show.mockImplementation(() => {
    throw new Error('Synthetic persistent window activation failure')
  })
  const code = Buffer.alloc(32, 7).toString('base64url')
  const commandLine = ['electron', `ldb-synthetic://auth/return?code=${code}`]

  expect(() => {
    secondInstanceListeners[0]({}, commandLine, '/tmp')
  }).not.toThrow()
  await vi.waitFor(() =>
    expect(mocks.coordinator.handleReturnUrl).toHaveBeenCalledExactlyOnceWith(
      commandLine[1],
      expect.any(Function)
    )
  )
  expect(window.show).toHaveBeenCalledOnce()
})

it('actual ingress는 malformed, 복수, pending 없는 callback에 window side effect를 만들지 않는다', async () => {
  stubTrustedRuntimeEnvironment()
  const actualProtocol =
    await vi.importActual<typeof import('./auth/protocol-ingress')>('./auth/protocol-ingress')
  mocks.createIngress.mockImplementationOnce(actualProtocol.createProtocolIngress)
  mocks.attachAfterStart.mockImplementationOnce(actualProtocol.attachProtocolIngressAfterStart)

  await import('./main')
  await mocks.bootstrap
  const registration = mocks.appOn.mock.calls.find(([event]) => event === 'second-instance')
  expect(registration).toBeDefined()
  const secondInstance = registration?.[1] as (
    event: unknown,
    commandLine: string[],
    cwd: string
  ) => void
  const window = mocks.windows[0] as { show: ReturnType<typeof vi.fn> }
  const code = Buffer.alloc(32, 7).toString('base64url')
  const otherCode = Buffer.alloc(32, 8).toString('base64url')
  const returnUrl = `ldb-synthetic://auth/return?code=${code}`

  secondInstance({}, ['electron', 'ldb-synthetic://auth/return?code=short'], '/tmp')
  secondInstance(
    {},
    ['electron', returnUrl, `ldb-synthetic://auth/return?code=${otherCode}`],
    '/tmp'
  )
  secondInstance({}, ['electron', 'ldb-wrong://auth/return'], '/tmp')
  secondInstance({}, ['electron', 'https://example.test/auth/return'], '/tmp')
  secondInstance({}, ['electron', ' \tldb-wrong://auth/return'], '/tmp')
  secondInstance({}, ['electron', '1bad://auth/return'], '/tmp')
  secondInstance({}, ['electron', 'x://auth/return'], '/tmp')
  secondInstance({}, ['electron', '\u0001mailto:user@example.test'], '/tmp')
  await Promise.resolve()

  expect(mocks.coordinator.handleReturnUrl).not.toHaveBeenCalled()
  expect(window.show).not.toHaveBeenCalled()

  mocks.coordinator.handleReturnUrl.mockImplementationOnce(async () => undefined)
  secondInstance({}, ['electron', returnUrl], '/tmp')
  await vi.waitFor(() =>
    expect(mocks.coordinator.handleReturnUrl).toHaveBeenCalledExactlyOnceWith(
      returnUrl,
      expect.any(Function)
    )
  )
  expect(window.show).not.toHaveBeenCalled()
})

it('warm return은 현재 창을 focus하고, 창이 없으면 같은 auth runtime으로 재생성한다', async () => {
  vi.stubEnv('LDB_AUTH_API_ORIGIN', 'https://api.synthetic.test')
  vi.stubEnv('LDB_AUTH_RETURN_TARGET', 'ldb-synthetic://auth/return')
  vi.stubEnv('LDB_AUTH_ENVIRONMENT', 'test')
  vi.stubEnv('LDB_AUTH_PROVIDERS', 'google')
  vi.stubEnv('LDB_AUTH_APP_IDENTITY', 'com.synthetic.ldb')
  vi.stubEnv('LDB_AUTH_USER_DATA_PATH', '/synthetic/ldb-test-profile')
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')

  await import('./main')
  await mocks.bootstrap
  const dispatch = mocks.attachIngress.mock.calls[0][0] as (raw: string) => Promise<void>
  const firstWindow = mocks.windows[0] as {
    show: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    isDestroyed: ReturnType<typeof vi.fn>
  }

  await dispatch('ldb-synthetic://auth/return?code=synthetic')
  expect(firstWindow.show).toHaveBeenCalledOnce()
  expect(firstWindow.focus).toHaveBeenCalledOnce()
  expect(mocks.coordinator.handleReturnUrl).toHaveBeenCalledWith(
    'ldb-synthetic://auth/return?code=synthetic',
    expect.any(Function)
  )

  firstWindow.isDestroyed = vi.fn(() => true)
  await dispatch('ldb-synthetic://auth/return?code=synthetic-2')
  expect(mocks.constructWindow).toHaveBeenCalledTimes(2)
  expect(mocks.registerAuth).toHaveBeenCalledTimes(2)
  expect(mocks.registerWindow).toHaveBeenCalledTimes(2)
  expect(mocks.coordinator.handleReturnUrl).toHaveBeenLastCalledWith(
    'ldb-synthetic://auth/return?code=synthetic-2',
    expect.any(Function)
  )
})

it('warm return은 창 활성화가 실패해도 auth callback을 먼저 처리한다', async () => {
  vi.stubEnv('LDB_AUTH_API_ORIGIN', 'https://api.synthetic.test')
  vi.stubEnv('LDB_AUTH_RETURN_TARGET', 'ldb-synthetic://auth/return')
  vi.stubEnv('LDB_AUTH_ENVIRONMENT', 'test')
  vi.stubEnv('LDB_AUTH_PROVIDERS', 'google')
  vi.stubEnv('LDB_AUTH_APP_IDENTITY', 'com.synthetic.ldb')
  vi.stubEnv('LDB_AUTH_USER_DATA_PATH', '/synthetic/ldb-test-profile')

  await import('./main')
  await mocks.bootstrap
  const dispatch = mocks.attachIngress.mock.calls[0][0] as (raw: string) => Promise<void>
  const window = mocks.windows[0] as { show: ReturnType<typeof vi.fn> }
  window.show.mockImplementationOnce(() => {
    throw new Error('Synthetic window activation failure')
  })
  const rawReturnUrl = 'ldb-synthetic://auth/return?code=synthetic'

  await expect(dispatch(rawReturnUrl)).resolves.toBeUndefined()

  expect(mocks.coordinator.handleReturnUrl).toHaveBeenCalledExactlyOnceWith(
    rawReturnUrl,
    expect.any(Function)
  )
})
