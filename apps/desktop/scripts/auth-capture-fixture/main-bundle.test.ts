import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { resolveConfig } from 'electron-vite'
import { build } from 'vite'
import { expect, it, vi } from 'vitest'

const requireDependency = createRequire(import.meta.url)

function mainEnvironment(): {
  context: ReturnType<typeof createContext>
  bootstrap: () => Promise<void> | undefined
  error: ReturnType<typeof vi.fn>
} {
  let bootstrap: Promise<void> | undefined
  const error = vi.fn()
  const session = {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() }
  }
  const electron = {
    app: {
      setPath: vi.fn(),
      setName: vi.fn(),
      on: vi.fn(),
      quit: vi.fn(),
      exit: vi.fn(),
      whenReady: () => ({
        then: (start: () => void | Promise<void>): Promise<void> => {
          bootstrap = Promise.resolve().then(start)
          return bootstrap
        }
      })
    },
    BrowserWindow: class {
      static getAllWindows(): never[] {
        return []
      }
      on = vi.fn()
      show = vi.fn()
      destroy = vi.fn()
      isDestroyed = (): boolean => false
      loadFile = vi.fn().mockResolvedValue(undefined)
      loadURL = vi.fn().mockResolvedValue(undefined)
      webContents = {
        mainFrame: { url: '', isDestroyed: () => false },
        isDestroyed: () => false,
        session,
        on: vi.fn(),
        send: vi.fn(),
        setWindowOpenHandler: vi.fn()
      }
    },
    ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    desktopCapturer: { getSources: vi.fn() },
    session: { defaultSession: session },
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    systemPreferences: { getMediaAccessStatus: () => 'granted' }
  }
  const requireModule = (name: string): unknown => {
    const isElectron = name === 'electron'
    if (isElectron) {
      return electron
    }
    const isToolkit = name === '@electron-toolkit/utils'
    if (isToolkit) {
      return {
        electronApp: { setAppUserModelId: vi.fn() },
        optimizer: { watchWindowShortcuts: vi.fn() },
        is: { dev: false }
      }
    }
    // Ky와 다른 Node dependency는 mock하지 않고 설치된 package를 CJS로 읽는다.
    return requireDependency(name)
  }
  const context = createContext({
    require: requireModule,
    exports: {},
    Buffer,
    URL,
    Request,
    Response,
    AbortController,
    TextEncoder,
    TextDecoder,
    performance,
    setTimeout,
    clearTimeout,
    __dirname: resolve('out/auth-capture-fixture/main'),
    process: {
      ppid: 424242,
      platform: process.platform,
      argv: ['electron', 'synthetic-main.cjs'],
      env: {
        LDB_AUTH_CAPTURE_PROFILE: join(tmpdir(), 'ldb-auth-capture-fixture-unit01'),
        LDB_AUTH_CAPTURE_LAUNCHER_PID: '424242'
      }
    },
    console: { log: vi.fn(), error, warn: vi.fn() }
  })
  return { context, bootstrap: () => bootstrap, error }
}

it.each(['electron.vite.config.ts', 'scripts/auth-capture-fixture.config.ts'])(
  '%s의 실제 main bundle은 기존 composition을 초기화할 수 있다',
  async (configFile) => {
    const resolved = await resolveConfig({ configFile, logLevel: 'silent' }, 'build', 'production')
    const main = resolved.config?.main
    expect(main).toBeDefined()
    const output = await build({
      ...main,
      logLevel: 'silent',
      build: { ...main!.build, write: false }
    })
    const bundles = Array.isArray(output) ? output : [output]
    const chunks: string[] = []
    for (const bundle of bundles) {
      const hasOutput = 'output' in bundle
      if (!hasOutput) {
        throw new Error('Expected completed main build')
      }
      for (const item of bundle.output) {
        const isChunk = item.type === 'chunk'
        if (isChunk) {
          chunks.push(item.code)
        }
      }
    }
    expect(chunks).toHaveLength(1)
    const environment = mainEnvironment()
    environment.context.__dirname = dirname(resolve(main!.build!.outDir!, 'main.cjs'))
    runInContext(chunks[0], environment.context)
    let failure: string | null = null
    try {
      await environment.bootstrap()
    } catch (error) {
      // VM의 다른 realm Error도 고정된 초기화 실패 원인으로 비교한다. Stack은 기록하지 않는다.
      failure = String(error)
    }
    expect(failure).toBeNull()
    expect(environment.error).not.toHaveBeenCalled()
  }
)
