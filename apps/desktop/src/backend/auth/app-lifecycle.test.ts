import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { createAuthAppLifecycle } from './app-lifecycle'

type QuitEvent = { defaultPrevented: boolean }
type App = Parameters<typeof createAuthAppLifecycle>[0]['app'] & {
  exit: ReturnType<typeof vi.fn>
}

function createApp(): {
  app: App
  handlers: Map<string, (...args: never[]) => void>
} {
  const handlers = new Map<string, (...args: never[]) => void>()
  const app = {
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      handlers.set(event, handler)
    }),
    exit: vi.fn()
  }
  return { app, handlers }
}

function createWindow(): {
  window: BrowserWindow
  handlers: Map<string, (...args: never[]) => void>
  webContentsHandlers: Map<string, (...args: never[]) => void>
  destroy: ReturnType<typeof vi.fn>
} {
  const handlers = new Map<string, (...args: never[]) => void>()
  const webContentsHandlers = new Map<string, (...args: never[]) => void>()
  const destroy = vi.fn()
  const window = {
    isDestroyed: vi.fn(() => false),
    destroy,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      handlers.set(event, handler)
    }),
    webContents: {
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        webContentsHandlers.set(event, handler)
      })
    }
  } as unknown as BrowserWindow
  return { window, handlers, webContentsHandlers, destroy }
}

function createLifecycle(): {
  lifecycle: ReturnType<typeof createAuthAppLifecycle>
  handlers: Map<string, (...args: never[]) => void>
  disposeIngress: ReturnType<typeof vi.fn>
  disposePowerMonitor: ReturnType<typeof vi.fn>
  app: App
} {
  const { app, handlers } = createApp()
  const disposeIngress = vi.fn()
  const disposePowerMonitor = vi.fn()
  const lifecycle = createAuthAppLifecycle({
    app,
    ownsAuthProfile: () => true,
    disposeProtocolIngress: disposeIngress
  })
  lifecycle.setPowerMonitorDisposer(disposePowerMonitor)
  lifecycle.registerAppHandlers()
  return { lifecycle, handlers, disposeIngress, disposePowerMonitor, app }
}

it('canceled quit resolves waiters and resumes deferred actions', async () => {
  const { lifecycle, handlers } = createLifecycle()
  const beforeQuit = handlers.get('before-quit')!
  const willQuit = handlers.get('will-quit')!
  const action = vi.fn()

  beforeQuit({ defaultPrevented: false } as never)
  const pendingAction = lifecycle.runAfterQuitOutcome(action)
  expect(action).not.toHaveBeenCalled()

  willQuit({ defaultPrevented: true } as never)
  await pendingAction

  expect(action).toHaveBeenCalledOnce()
  expect(lifecycle.isQuitting()).toBe(false)
  expect(lifecycle.isShutdownCommitted()).toBe(false)
  expect(lifecycle.canReceiveProtocolIngress()).toBe(true)
})

it('committed quit resolves waiters as terminal and releases auth resources once', async () => {
  const { lifecycle, handlers, disposeIngress, disposePowerMonitor, app } = createLifecycle()
  const beforeQuit = handlers.get('before-quit')!
  const quit = handlers.get('quit')!
  const action = vi.fn()

  beforeQuit({ defaultPrevented: false } as never)
  const pendingAction = lifecycle.runAfterQuitOutcome(action)
  quit()
  await pendingAction

  expect(action).not.toHaveBeenCalled()
  expect(disposePowerMonitor).toHaveBeenCalledOnce()
  expect(disposeIngress).toHaveBeenCalledOnce()
  expect(app.exit).not.toHaveBeenCalled()
  expect(lifecycle.isShutdownCommitted()).toBe(true)
  expect(lifecycle.canReceiveProtocolIngress()).toBe(false)

  quit()
  expect(disposePowerMonitor).toHaveBeenCalledOnce()
  expect(disposeIngress).toHaveBeenCalledOnce()
})

it('owned document load failure clears the window, IPC, ingress, and exits nonzero', async () => {
  const { lifecycle, disposeIngress, app } = createLifecycle()
  const { window, destroy } = createWindow()
  const disposeAuthIpc = vi.fn()

  lifecycle.publishWindow(window, disposeAuthIpc)
  lifecycle.registerWindow(window)(Promise.reject(new Error('synthetic load failure')))
  await vi.waitFor(() => expect(app.exit).toHaveBeenCalledExactlyOnceWith(1))

  expect(lifecycle.getWindow()).toBeNull()
  expect(disposeAuthIpc).toHaveBeenCalledOnce()
  expect(disposeIngress).toHaveBeenCalledOnce()
  expect(destroy).toHaveBeenCalledOnce()
})

it('load failure held by a canceled close is handled after close cancellation', async () => {
  const { lifecycle, disposeIngress, app } = createLifecycle()
  const { window, handlers, destroy } = createWindow()
  const disposeAuthIpc = vi.fn()
  let rejectLoad!: (error: unknown) => void
  const load = new Promise<void>((_resolve, reject) => {
    rejectLoad = reject
  })

  lifecycle.publishWindow(window, disposeAuthIpc)
  lifecycle.registerWindow(window)(load)
  rejectLoad(new Error('synthetic canceled-close load failure'))
  let defaultPrevented = false
  const closeEvent = {
    get defaultPrevented() {
      return defaultPrevented
    }
  } as QuitEvent
  handlers.get('close')!(closeEvent as never)
  defaultPrevented = true
  await load.catch(() => undefined)
  await Promise.resolve()

  expect(app.exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(disposeIngress).toHaveBeenCalledOnce()
  expect(disposeAuthIpc).toHaveBeenCalledOnce()
  expect(destroy).toHaveBeenCalledOnce()
})
