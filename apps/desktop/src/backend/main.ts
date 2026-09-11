import { app, BrowserWindow, session } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { validateDevRendererUrl } from './renderer-document'
import { registerCaptureIpc, registerCaptureWindow } from './capture/ipc-handler'
import { registerCapturePermissions } from './capture/permission-policy'
import { registerAuthIpc } from './auth/ipc-handler'
import { attachProtocolIngressAfterStart, createProtocolIngress } from './auth/protocol-ingress'
import { bootstrapAuthRuntime, type AuthRuntime } from './auth/bootstrap'
import { createAuthRuntimeEffects } from './auth/runtime-effects'
import {
  applyAuthRuntimeProfile,
  AuthRuntimeProfileApplicationFailure,
  readAuthRuntimeConfig
} from './auth/runtime-config'

let mainWindow: BrowserWindow | null = null
let disposeAuthIpc: (() => void) | undefined
let runtimeProfileApplicationFailed = false
const parsedRuntimeConfig = readAuthRuntimeConfig()
const runtimeConfig = (() => {
  if (parsedRuntimeConfig == null) {
    return null
  }
  try {
    applyAuthRuntimeProfile(app, parsedRuntimeConfig)
    return parsedRuntimeConfig
  } catch (error) {
    const isApplicationFailure = error instanceof AuthRuntimeProfileApplicationFailure
    runtimeProfileApplicationFailed = isApplicationFailure
    return null
  }
})()
const protocolIngress =
  runtimeConfig == null
    ? null
    : createProtocolIngress({ app, argv: process.argv, returnTarget: runtimeConfig.returnTarget })
let protocolIngressDisposed = false

if (runtimeProfileApplicationFailed) {
  app.exit(1)
}

function createWindow(authRuntime: AuthRuntime | null): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const isDevelopment = is.dev
  const hasDevUrl = devUrl != null
  const shouldLoadDevUrl = isDevelopment && hasDevUrl
  const entry = join(__dirname, '../frontend/index.html')
  const rendererDocumentUrl = shouldLoadDevUrl
    ? validateDevRendererUrl(devUrl)
    : pathToFileURL(entry).href
  const isLinux = process.platform === 'linux'
  const window = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(isLinux ? { icon } : {}),
    webPreferences: {
      backgroundThrottling: false,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow = window
  registerCapturePermissions(session.defaultSession)
  registerCaptureWindow(window, rendererDocumentUrl)
  if (authRuntime != null) {
    disposeAuthIpc?.()
    disposeAuthIpc = registerAuthIpc({
      coordinator: authRuntime.coordinator,
      getWindow: () => mainWindow,
      documentUrl: rendererDocumentUrl
    })
  }

  window.on('closed', () => {
    const isCurrentWindow = mainWindow === window
    if (isCurrentWindow) {
      disposeAuthIpc?.()
      disposeAuthIpc = undefined
      mainWindow = null
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (shouldLoadDevUrl) {
    void window.loadURL(rendererDocumentUrl)
  } else {
    void window.loadFile(entry)
  }
}

function showOrCreateMainWindow(authRuntime: AuthRuntime | null): void {
  const window = mainWindow
  const hasWindow = window != null && !window.isDestroyed()
  if (!hasWindow) {
    createWindow(authRuntime)
    return
  }

  window.show()
  window.focus()
}

function disposeProtocolIngress(): void {
  protocolIngressDisposed = true
  protocolIngress?.dispose()
}

// This method will be called when Electron has finished initialization and is ready to create windows.
app.whenReady().then(async () => {
  if (runtimeProfileApplicationFailed) {
    return
  }

  const hasOwnedInstance = protocolIngress == null || protocolIngress.ownsInstance
  if (!hasOwnedInstance) {
    return
  }

  app.on('before-quit', disposeProtocolIngress)

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  let authRuntime: AuthRuntime | null = null
  if (runtimeConfig != null) {
    try {
      const effects = createAuthRuntimeEffects({ config: runtimeConfig })
      authRuntime = await bootstrapAuthRuntime({ config: runtimeConfig, effects })
    } catch {
      authRuntime = null
    }
  }
  const hasAuthRuntime = authRuntime != null
  if (!hasAuthRuntime) {
    disposeProtocolIngress()
  }
  const searchConfiguration =
    authRuntime == null
      ? undefined
      : {
          apiOrigin: authRuntime.apiOrigin,
          clock: authRuntime.searchClock
        }
  registerCaptureIpc(authRuntime?.coordinator, searchConfiguration)

  createWindow(authRuntime)

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    const hasNoOpenWindows = BrowserWindow.getAllWindows().length === 0
    if (hasNoOpenWindows) {
      createWindow(authRuntime)
    }
  })
  app.on('second-instance', () => {
    showOrCreateMainWindow(authRuntime)
  })
  app.on('window-all-closed', () => {
    const shouldQuit = process.platform !== 'darwin'
    if (shouldQuit) {
      app.quit()
    }
  })

  const startAuthRuntime = authRuntime?.start()
  void startAuthRuntime?.catch(() => undefined)
  if (authRuntime != null && protocolIngress != null && startAuthRuntime != null) {
    attachProtocolIngressAfterStart(
      protocolIngress,
      startAuthRuntime,
      async (rawReturnUrl) => {
        const handlingReturnUrl = authRuntime.coordinator.handleReturnUrl(rawReturnUrl)
        try {
          showOrCreateMainWindow(authRuntime)
        } finally {
          await handlingReturnUrl
        }
      },
      () => !protocolIngressDisposed
    )
  }
})
