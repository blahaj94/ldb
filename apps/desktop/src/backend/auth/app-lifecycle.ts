import type { BrowserWindow } from 'electron'

type QuitEvent = Readonly<{ defaultPrevented: boolean }>

type AuthAppLifecycleOptions = Readonly<{
  app: {
    on(event: 'before-quit', listener: (event: QuitEvent) => void): void
    on(event: 'will-quit', listener: (event: QuitEvent) => void): void
    on(event: 'quit', listener: () => void): void
    exit(code?: number): void
  }
  ownsAuthProfile(): boolean
  disposeProtocolIngress(): void
}>

export type AuthAppLifecycle = Readonly<{
  registerAppHandlers(): void
  getWindow(): BrowserWindow | null
  prepareWindow(): void
  publishWindow(window: BrowserWindow, disposeAuthIpc?: () => void): void
  registerWindow(window: BrowserWindow): (load: unknown) => void
  destroyWindow(window: BrowserWindow): void
  setPowerMonitorDisposer(dispose: () => void): void
  disposeExternalResources(): void
  isQuitting(): boolean
  isShutdownCommitted(): boolean
  canReceiveProtocolIngress(): boolean
  waitForQuitOutcome(): Promise<boolean>
  runBootstrap<T>(bootstrap: (isActive: () => boolean) => Promise<T | null>): Promise<T | null>
  runAfterQuitOutcome(action: () => Promise<void> | void): Promise<void> | void
  exitAfterOwnedAuthFailure(): void
}>

type WindowCloseState = {
  activeAttempt: symbol | null
  hasPendingLoadFailure: boolean
}

export function createAuthAppLifecycle(options: AuthAppLifecycleOptions): AuthAppLifecycle {
  let mainWindow: BrowserWindow | null = null
  let disposeAuthIpc: (() => void) | undefined
  let disposeClockPowerMonitor: (() => void) | undefined
  let protocolIngressDisposed = false
  let isQuitting = false
  let activeQuitAttempt: symbol | null = null
  let shutdownCommitted = false
  let hasPendingOwnedAuthFailure = false
  let quitOutcomeWaiters: Array<(canResume: boolean) => void> = []
  let quitCancellationActions: Array<() => void> = []
  let ownedAuthFailureExitRequested = false
  let appHandlersRegistered = false

  function destroyWindowBestEffort(window: BrowserWindow): void {
    try {
      if (!window.isDestroyed()) {
        window.destroy()
      }
    } catch {
      // The composition or load failure remains the owning failure.
    }
  }

  function disposeCurrentAuthIpc(): void {
    disposeAuthIpc?.()
    disposeAuthIpc = undefined
  }

  function handleDocumentLoadFailure(window: BrowserWindow, closeState: WindowCloseState): void {
    const isCurrentWindow = mainWindow === window
    if (!isCurrentWindow) {
      return
    }
    const hasActiveWindowCloseAttempt = closeState.activeAttempt != null
    if (hasActiveWindowCloseAttempt) {
      closeState.hasPendingLoadFailure = true
      return
    }
    if (shutdownCommitted) {
      return
    }
    const hasActiveQuitAttempt = activeQuitAttempt != null
    if (hasActiveQuitAttempt) {
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
    if (options.ownsAuthProfile()) {
      exitAfterOwnedAuthFailure()
    }
    destroyWindowBestEffort(window)
  }

  function cancelWindowCloseAttempt(
    window: BrowserWindow,
    closeState: WindowCloseState,
    attempt: symbol
  ): void {
    const isDifferentWindowCloseAttempt = closeState.activeAttempt !== attempt
    if (isDifferentWindowCloseAttempt) {
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
    load: unknown
  ): void {
    void Promise.resolve(load).catch(() => handleDocumentLoadFailure(window, closeState))
  }

  function registerWindow(window: BrowserWindow): (load: unknown) => void {
    const closeState: WindowCloseState = {
      activeAttempt: null,
      hasPendingLoadFailure: false
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
        disposeCurrentAuthIpc()
        mainWindow = null
      }
    })

    window.webContents.on('will-prevent-unload', (event) => {
      const attempt = closeState.activeAttempt
      const hasNoActiveWindowCloseAttempt = attempt == null
      if (hasNoActiveWindowCloseAttempt) {
        return
      }
      queueMicrotask(() => {
        if (!event.defaultPrevented) {
          cancelWindowCloseAttempt(window, closeState, attempt)
        }
      })
    })

    return (load: unknown): void => {
      observeDocumentLoad(window, closeState, load)
    }
  }

  function disposeProtocolIngress(): void {
    if (protocolIngressDisposed) {
      return
    }

    protocolIngressDisposed = true
    options.disposeProtocolIngress()
  }

  function disposePowerMonitor(): void {
    disposeClockPowerMonitor?.()
    disposeClockPowerMonitor = undefined
  }

  function disposeExternalResources(): void {
    disposePowerMonitor()
    disposeProtocolIngress()
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
    disposeExternalResources()
  }

  function cancelQuitAttempt(attempt: symbol): void {
    const hasCommittedShutdown = shutdownCommitted
    const isDifferentQuitAttempt = activeQuitAttempt !== attempt
    const isStaleQuitAttempt = hasCommittedShutdown || isDifferentQuitAttempt
    if (isStaleQuitAttempt) {
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
    const hasActiveQuitAttempt = attempt != null
    if (hasActiveQuitAttempt) {
      cancelQuitAttempt(attempt)
    }
  }

  function beginQuitAttempt(event: QuitEvent): void {
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

  function observeQuitAttempt(event: QuitEvent): void {
    const attempt = activeQuitAttempt
    const hasNoActiveQuitAttempt = attempt == null
    if (hasNoActiveQuitAttempt) {
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
    const hasNoActiveQuitAttempt = activeQuitAttempt == null
    if (hasNoActiveQuitAttempt) {
      return Promise.resolve(true)
    }

    return new Promise((resolve) => {
      quitOutcomeWaiters.push(resolve)
    })
  }

  async function runBootstrap<T>(
    bootstrap: (isActive: () => boolean) => Promise<T | null>
  ): Promise<T | null> {
    let bootstrapResult: T | null = null
    let shouldRunBootstrap = true
    while (shouldRunBootstrap) {
      let bootstrapObservedQuitAttempt = false
      bootstrapResult = await bootstrap(() => {
        const isCancellableQuitActive = isQuitting && !shutdownCommitted
        bootstrapObservedQuitAttempt ||= isCancellableQuitActive
        return !isQuitting
      })
      if (shutdownCommitted) {
        return null
      }
      if (isQuitting) {
        const canResume = await waitForQuitOutcome()
        if (!canResume) {
          return null
        }
      }
      const hasBootstrapResult = bootstrapResult != null
      shouldRunBootstrap = bootstrapObservedQuitAttempt && !hasBootstrapResult
    }
    return bootstrapResult
  }

  function runAfterQuitOutcome(action: () => Promise<void> | void): Promise<void> | void {
    if (shutdownCommitted) {
      return
    }
    const hasNoActiveQuitAttempt = activeQuitAttempt == null
    if (hasNoActiveQuitAttempt) {
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
    const hasActiveQuitAttempt = activeQuitAttempt != null
    if (hasActiveQuitAttempt) {
      hasPendingOwnedAuthFailure = true
      return
    }

    ownedAuthFailureExitRequested = true
    commitShutdown()
    options.app.exit(1)
  }

  function registerAppHandlers(): void {
    if (appHandlersRegistered) {
      return
    }

    appHandlersRegistered = true
    options.app.on('before-quit', beginQuitAttempt)
    options.app.on('will-quit', observeQuitAttempt)
    options.app.on('quit', commitShutdown)
  }

  return {
    registerAppHandlers,
    getWindow: () => mainWindow,
    prepareWindow: () => {
      disposeCurrentAuthIpc()
      mainWindow = null
    },
    publishWindow: (window, dispose) => {
      disposeAuthIpc = dispose
      mainWindow = window
    },
    registerWindow,
    destroyWindow: destroyWindowBestEffort,
    setPowerMonitorDisposer: (dispose) => {
      if (shutdownCommitted) {
        dispose()
        return
      }
      disposeClockPowerMonitor = dispose
    },
    disposeExternalResources,
    isQuitting: () => isQuitting,
    isShutdownCommitted: () => shutdownCommitted,
    canReceiveProtocolIngress: () => !shutdownCommitted && !protocolIngressDisposed,
    waitForQuitOutcome,
    runBootstrap,
    runAfterQuitOutcome,
    exitAfterOwnedAuthFailure
  }
}
