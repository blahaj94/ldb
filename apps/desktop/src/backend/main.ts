import { app, BrowserWindow, powerMonitor, session } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { validateDevRendererUrl } from './renderer-document'
import { registerCaptureIpc, registerCaptureWindow } from './capture/ipc-handler'
import { registerCapturePermissions } from './capture/permission-policy'
import { registerAuthIpc } from './auth/ipc-handler'
import {
  attachProtocolIngressAfterStart,
  createProtocolIngress,
  isOrdinarySecondInstanceInvocation,
  selectProtocolIngressArguments
} from './auth/protocol-ingress'
import { bootstrapAuthRuntime, type AuthRuntime } from './auth/bootstrap'
import { createAuthRuntimeEffects } from './auth/runtime-effects'
import {
  applyAuthRuntimeProfile,
  AuthRuntimeProfileApplicationFailure,
  readAuthRuntimeConfig
} from './auth/runtime-config'

let mainWindow: BrowserWindow | null = null
let disposeAuthIpc: (() => void) | undefined
let disposeClockPowerMonitor: (() => void) | undefined
const parsedRuntimeConfig = readAuthRuntimeConfig()
type RuntimeProfileState =
  | Readonly<{ status: 'inactive-config' }>
  | Readonly<{ status: 'preparation-failed' }>
  | Readonly<{ status: 'application-failed' }>
  | Readonly<{ status: 'applied'; config: NonNullable<typeof parsedRuntimeConfig> }>
const runtimeProfileState: RuntimeProfileState = (() => {
  if (parsedRuntimeConfig == null) {
    return { status: 'inactive-config' }
  }
  try {
    const appliedConfig = applyAuthRuntimeProfile(app, parsedRuntimeConfig)
    return { status: 'applied', config: appliedConfig }
  } catch (error) {
    const isApplicationFailure = error instanceof AuthRuntimeProfileApplicationFailure
    return { status: isApplicationFailure ? 'application-failed' : 'preparation-failed' }
  }
})()
const runtimeConfig = runtimeProfileState.status === 'applied' ? runtimeProfileState.config : null
const protocolIngress =
  runtimeConfig == null
    ? null
    : createProtocolIngress({
        app,
        argv: selectProtocolIngressArguments(process.argv, process.defaultApp === true),
        returnTarget: runtimeConfig.returnTarget
      })
let protocolIngressDisposed = false
let isQuitting = false
let activeQuitAttempt: symbol | null = null
let shutdownCommitted = false
let hasPendingOwnedAuthFailure = false
let quitOutcomeWaiters: Array<(canResume: boolean) => void> = []
let quitCancellationActions: Array<() => void> = []
let ownedAuthFailureExitRequested = false

if (runtimeProfileState.status === 'application-failed') {
  app.exit(1)
}

function destroyWindowBestEffort(window: BrowserWindow): void {
  try {
    if (!window.isDestroyed()) {
      window.destroy()
    }
  } catch {
    // The composition or load failure remains the owning failure.
  }
}

type WindowCloseState = {
  activeAttempt: symbol | null
  hasPendingLoadFailure: boolean
}

function handleDocumentLoadFailure(window: BrowserWindow, closeState: WindowCloseState): void {
  const isCurrentWindow = mainWindow === window
  if (!isCurrentWindow) {
    return
  }
  if (closeState.activeAttempt != null) {
    closeState.hasPendingLoadFailure = true
    return
  }
  if (shutdownCommitted) {
    return
  }
  if (activeQuitAttempt != null) {
    quitCancellationActions.push(() => handleDocumentLoadFailure(window, closeState))
    return
  }

  mainWindow = null
  const dispose = disposeAuthIpc
  disposeAuthIpc = undefined
  try {
    dispose?.()
  } catch {
    // Continue invalidating the failed document owner.
  }
  const ownsAuthProfile = protocolIngress?.ownsInstance === true
  if (ownsAuthProfile) {
    exitAfterOwnedAuthFailure()
  }
  destroyWindowBestEffort(window)
}

function cancelWindowCloseAttempt(
  window: BrowserWindow,
  closeState: WindowCloseState,
  attempt: symbol
): void {
  if (closeState.activeAttempt !== attempt) {
    return
  }

  closeState.activeAttempt = null
  cancelActiveQuitAttempt()
  if (!closeState.hasPendingLoadFailure) {
    return
  }

  closeState.hasPendingLoadFailure = false
  handleDocumentLoadFailure(window, closeState)
}

function observeDocumentLoad(
  window: BrowserWindow,
  closeState: WindowCloseState,
  load: Promise<unknown>
): void {
  void Promise.resolve(load).catch(() => handleDocumentLoadFailure(window, closeState))
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
  const previousWindow = mainWindow
  const hasReusableWindow = previousWindow != null && !previousWindow.isDestroyed()
  if (hasReusableWindow) {
    throw new Error('Main window already exists.')
  }
  disposeAuthIpc?.()
  disposeAuthIpc = undefined
  mainWindow = null
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
  const closeState: WindowCloseState = {
    activeAttempt: null,
    hasPendingLoadFailure: false
  }

  let nextDisposeAuthIpc: (() => void) | undefined
  try {
    registerCapturePermissions(session.defaultSession)
    registerCaptureWindow(window, rendererDocumentUrl)
    if (authRuntime != null) {
      nextDisposeAuthIpc = registerAuthIpc({
        coordinator: authRuntime.coordinator,
        getWindow: () => (mainWindow === window ? window : null),
        documentUrl: rendererDocumentUrl
      })
    }

    window.on('close', (event) => {
      const attempt = Symbol('main-window-close-attempt')
      closeState.activeAttempt = attempt
      queueMicrotask(() => {
        if (event.defaultPrevented) {
          cancelWindowCloseAttempt(window, closeState, attempt)
        }
      })
    })

    window.on('closed', () => {
      closeState.activeAttempt = null
      closeState.hasPendingLoadFailure = false
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
    window.webContents.on('will-prevent-unload', (event) => {
      const attempt = closeState.activeAttempt
      if (attempt == null) {
        return
      }
      queueMicrotask(() => {
        if (!event.defaultPrevented) {
          cancelWindowCloseAttempt(window, closeState, attempt)
        }
      })
    })

    if (shouldLoadDevUrl) {
      observeDocumentLoad(window, closeState, window.loadURL(rendererDocumentUrl))
    } else {
      observeDocumentLoad(window, closeState, window.loadFile(entry))
    }
  } catch (error) {
    try {
      nextDisposeAuthIpc?.()
    } catch {
      // Continue rolling back the unpublished window.
    }
    destroyWindowBestEffort(window)
    throw error
  }

  disposeAuthIpc = nextDisposeAuthIpc
  mainWindow = window
}

function showOrCreateMainWindow(authRuntime: AuthRuntime | null): void {
  const window = mainWindow
  const hasWindow = window != null && !window.isDestroyed()
  if (!hasWindow) {
    createWindow(authRuntime)
    return
  }

  if (window.isMinimized()) {
    window.restore()
  }
  window.show()
  window.focus()
}

function disposeProtocolIngress(): void {
  if (protocolIngressDisposed) {
    return
  }

  protocolIngressDisposed = true
  protocolIngress?.dispose()
}

function commitShutdown(): void {
  if (shutdownCommitted) {
    return
  }

  shutdownCommitted = true
  activeQuitAttempt = null
  hasPendingOwnedAuthFailure = false
  quitCancellationActions = []
  isQuitting = true
  const waiters = quitOutcomeWaiters
  quitOutcomeWaiters = []
  for (const resolve of waiters) {
    resolve(false)
  }
  disposeClockPowerMonitor?.()
  disposeClockPowerMonitor = undefined
  disposeProtocolIngress()
}

function cancelQuitAttempt(attempt: symbol): void {
  if (shutdownCommitted || activeQuitAttempt !== attempt) {
    return
  }

  activeQuitAttempt = null
  isQuitting = false
  const cancellationActions = quitCancellationActions
  quitCancellationActions = []
  for (const action of cancellationActions) {
    action()
  }

  if (hasPendingOwnedAuthFailure && !shutdownCommitted) {
    hasPendingOwnedAuthFailure = false
    exitAfterOwnedAuthFailure()
  }
  if (shutdownCommitted) {
    return
  }

  const waiters = quitOutcomeWaiters
  quitOutcomeWaiters = []
  for (const resolve of waiters) {
    resolve(true)
  }
}

function cancelActiveQuitAttempt(): void {
  const attempt = activeQuitAttempt
  if (attempt != null) {
    cancelQuitAttempt(attempt)
  }
}

function beginQuitAttempt(event: Readonly<{ defaultPrevented: boolean }>): void {
  if (shutdownCommitted) {
    return
  }

  const attempt = activeQuitAttempt ?? Symbol('app-quit-attempt')
  activeQuitAttempt ??= attempt
  isQuitting = true
  queueMicrotask(() => {
    if (event.defaultPrevented) {
      cancelQuitAttempt(attempt)
    }
  })
}

function observeQuitAttempt(event: Readonly<{ defaultPrevented: boolean }>): void {
  const attempt = activeQuitAttempt
  if (attempt == null) {
    return
  }

  queueMicrotask(() => {
    if (event.defaultPrevented) {
      cancelQuitAttempt(attempt)
    }
  })
}

function waitForQuitOutcome(): Promise<boolean> {
  if (shutdownCommitted) {
    return Promise.resolve(false)
  }
  if (activeQuitAttempt == null) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    quitOutcomeWaiters.push(resolve)
  })
}

function runAfterQuitOutcome(action: () => Promise<void> | void): Promise<void> | void {
  if (shutdownCommitted) {
    return
  }
  if (activeQuitAttempt == null) {
    return action()
  }

  return waitForQuitOutcome().then(async (canResume) => {
    if (!canResume || shutdownCommitted) {
      return
    }
    await action()
  })
}

function exitAfterOwnedAuthFailure(): void {
  if (shutdownCommitted || ownedAuthFailureExitRequested) {
    return
  }
  if (activeQuitAttempt != null) {
    hasPendingOwnedAuthFailure = true
    return
  }

  ownedAuthFailureExitRequested = true
  commitShutdown()
  app.exit(1)
}

function activateWindowSafely(authRuntime: AuthRuntime | null): void {
  if (isQuitting) {
    return
  }

  try {
    showOrCreateMainWindow(authRuntime)
  } catch {
    return
  }
}

// This method will be called when Electron has finished initialization and is ready to create windows.
app.whenReady().then(async () => {
  if (runtimeProfileState.status === 'application-failed') {
    return
  }

  const hasOwnedInstance = protocolIngress == null || protocolIngress.ownsInstance
  if (!hasOwnedInstance) {
    return
  }

  app.on('before-quit', beginQuitAttempt)
  app.on('will-quit', observeQuitAttempt)
  app.on('quit', commitShutdown)

  try {
    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    let authRuntime: AuthRuntime | null = null
    if (runtimeConfig != null) {
      const effects = createAuthRuntimeEffects()
      disposeClockPowerMonitor = effects.bindPowerMonitor(powerMonitor)
      while (authRuntime == null) {
        let bootstrapObservedQuitAttempt = false
        authRuntime = await bootstrapAuthRuntime({
          config: runtimeConfig,
          effects,
          isActive: () => {
            bootstrapObservedQuitAttempt ||= isQuitting && !shutdownCommitted
            return !isQuitting
          }
        })
        if (shutdownCommitted) {
          return
        }
        if (isQuitting) {
          const canResume = await waitForQuitOutcome()
          if (!canResume) {
            return
          }
        }
        if (!bootstrapObservedQuitAttempt || authRuntime != null) {
          break
        }
      }
    }

    const hasAuthRuntime = authRuntime != null
    if (!hasAuthRuntime) {
      disposeClockPowerMonitor?.()
      disposeClockPowerMonitor = undefined
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
      if (isQuitting) {
        return
      }

      try {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        const hasNoOpenWindows = BrowserWindow.getAllWindows().length === 0
        if (hasNoOpenWindows) {
          createWindow(authRuntime)
        }
      } catch (error) {
        const ownsAuthProfile = protocolIngress?.ownsInstance === true
        if (ownsAuthProfile) {
          exitAfterOwnedAuthFailure()
          return
        }
        throw error
      }
    })
    if (authRuntime == null) {
      app.on('second-instance', (_event, _commandLine, _workingDirectory, additionalData) => {
        const isOrdinaryInvocation =
          runtimeConfig == null ||
          isOrdinarySecondInstanceInvocation(additionalData, runtimeConfig.returnTarget)
        if (isOrdinaryInvocation) {
          activateWindowSafely(authRuntime)
        }
      })
    }
    app.on('window-all-closed', () => {
      const shouldQuit = process.platform !== 'darwin'
      if (shouldQuit) {
        app.quit()
      }
    })

    const startAuthRuntime = authRuntime?.start()
    void startAuthRuntime?.catch(exitAfterOwnedAuthFailure)
    if (authRuntime != null && protocolIngress != null && startAuthRuntime != null) {
      attachProtocolIngressAfterStart(
        protocolIngress,
        startAuthRuntime,
        (rawReturnUrl) =>
          runAfterQuitOutcome(() =>
            authRuntime.coordinator.handleReturnUrl(rawReturnUrl, () => {
              activateWindowSafely(authRuntime)
            })
          ),
        () => !shutdownCommitted && !protocolIngressDisposed,
        () => runAfterQuitOutcome(() => activateWindowSafely(authRuntime))
      )
    }
  } catch (error) {
    if (shutdownCommitted) {
      return
    }

    const ownsAuthProfile = protocolIngress?.ownsInstance === true
    if (ownsAuthProfile) {
      exitAfterOwnedAuthFailure()
      return
    }
    if (isQuitting) {
      return
    }
    throw error
  }
})
