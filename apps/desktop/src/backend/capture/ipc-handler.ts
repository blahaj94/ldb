import {
  desktopCapturer,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WebFrameMain
} from 'electron'
import { addHandler } from '../ipc'
import type { AuthClock, AuthCoordinator } from '../auth/types'
import { CaptureSearchLifetime, type CaptureBinding } from '../search/capture-lifetime'
import { parseSearchControl, parseSearchObservation } from '../search/commands'
import { createSearchHttp } from '../search/http'
import { findSelectedSource, isCaptureRequestAllowed } from './capture-policy'

let captureWindow: BrowserWindow | null = null
let documentUrl: string | null = null
let windowGeneration = 0
let sourceSelectionGeneration = 0
let selectedSourceId: string | null = null
let selectingSource = false
let auth: AuthCoordinator | undefined
let unsubscribe: (() => void) | undefined
let search: CaptureSearchLifetime | undefined

async function getWindowSources(): Promise<Electron.DesktopCapturerSource[]> {
  return desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  })
}

function clearSource(): void {
  selectedSourceId = null
  selectingSource = false
  sourceSelectionGeneration += 1
  search?.invalidate()
}

function isTrustedFrame(window: BrowserWindow | null, frame: WebFrameMain | null): boolean {
  const isRegisteredWindow = window != null && window === captureWindow
  const isWindowAlive =
    isRegisteredWindow && !window.isDestroyed() && !window.webContents.isDestroyed()
  if (!isWindowAlive) {
    return false
  }
  const isMainFrame = frame != null && frame === window.webContents.mainFrame
  const hasExactDocument = isMainFrame && !frame.isDestroyed() && frame.url === documentUrl
  return hasExactDocument
}

function requireSender(event: IpcMainInvokeEvent, expected = captureWindow): void {
  const isTrusted = isTrustedFrame(expected, event.senderFrame)
  const isSender = event.sender === expected?.webContents
  const isAllowed = isTrusted && isSender
  if (!isAllowed) {
    throw new Error('Capture source access denied')
  }
}

function requireSearchSender(event: IpcMainInvokeEvent): void {
  const isTrusted = isTrustedFrame(captureWindow, event.senderFrame)
  const isSender = event.sender === captureWindow?.webContents
  const isAllowed = isTrusted && isSender
  if (!isAllowed) {
    throw new Error('SEARCH_NOT_ALLOWED')
  }
}

function requireCaptureGeneration(): number {
  const generation = auth?.captureGeneration()
  const hasPermission = generation != null
  if (!hasPermission) {
    throw new Error('Capture source access denied')
  }
  return generation
}

function isCurrentCapture(generation: number, startedWindowGeneration: number): boolean {
  const hasSameAuth = auth?.captureGeneration() === generation
  const hasSameWindow = windowGeneration === startedWindowGeneration
  const isCurrent = hasSameAuth && hasSameWindow
  return isCurrent
}

function currentMainFrame(): WebFrameMain | null {
  const window = captureWindow
  const isAlive = window != null && !window.isDestroyed() && !window.webContents.isDestroyed()
  if (!isAlive) {
    return null
  }
  return window.webContents.mainFrame
}

function isCurrentSearch(binding: CaptureBinding): boolean {
  const hasSameAuth = binding.authGeneration === auth?.captureGeneration()
  const hasSameWindow = binding.windowGeneration === windowGeneration
  const hasSameSource = binding.sourceGeneration === sourceSelectionGeneration
  const hasSource = selectedSourceId != null && !selectingSource
  const isTrusted = isTrustedFrame(captureWindow, currentMainFrame())
  const isCurrent = hasSameAuth && hasSameWindow && hasSameSource && hasSource && isTrusted
  return isCurrent
}

function registerCaptureIpc(
  coordinator?: AuthCoordinator,
  configuration?: { apiOrigin: string; fetch?: typeof fetch; clock: AuthClock }
): () => void {
  unsubscribe?.()
  auth = coordinator
  const hasRuntime = coordinator != null && configuration != null
  const runtime = hasRuntime
    ? { auth: coordinator, http: createSearchHttp(configuration), clock: configuration.clock }
    : undefined
  const lifetime = new CaptureSearchLifetime({
    runtime,
    isCurrent: isCurrentSearch,
    publish: (snapshot) => {
      const window = captureWindow
      const canPublish = isTrustedFrame(window, currentMainFrame())
      if (canPublish) {
        window!.webContents.send('characterSearchChanged', snapshot)
      }
    }
  })
  search = lifetime
  clearSource()
  unsubscribe = auth?.subscribe(() => {
    const isUnauthorized = auth?.captureGeneration() == null
    if (isUnauthorized) {
      clearSource()
    }
  })

  addHandler('listCaptureSources', async (event) => {
    const window = captureWindow
    const startedWindowGeneration = windowGeneration
    requireSender(event, window)
    const generation = requireCaptureGeneration()
    const sources = await getWindowSources()
    requireSender(event, window)
    const isCurrent = isCurrentCapture(generation, startedWindowGeneration)
    if (!isCurrent) {
      throw new Error('Capture source access denied')
    }
    return sources.map(({ id, name }) => ({ id, name }))
  })

  addHandler('selectCaptureSource', async (event, sourceId) => {
    const window = captureWindow
    const startedWindowGeneration = windowGeneration
    requireSender(event, window)
    const isSourceIdString = typeof sourceId === 'string'
    if (!isSourceIdString) {
      throw new Error('Capture source selection denied')
    }
    const isCleanup = sourceId.length === 0
    if (isCleanup) {
      clearSource()
      return null
    }
    const generation = requireCaptureGeneration()
    clearSource()
    const selectionGeneration = sourceSelectionGeneration
    selectingSource = true
    try {
      const source = findSelectedSource(await getWindowSources(), sourceId)
      requireSender(event, window)
      const isCurrent = isCurrentCapture(generation, startedWindowGeneration)
      if (!isCurrent) {
        throw new Error('Capture source selection denied')
      }
      const isLatestSelection = selectionGeneration === sourceSelectionGeneration
      if (!isLatestSelection) {
        return null
      }
      const hasSource = source != null
      if (!hasSource) {
        throw new Error('Selected capture source is no longer available')
      }
      selectedSourceId = source.id
      return { id: source.id, name: source.name }
    } finally {
      const isLatestSelection = selectionGeneration === sourceSelectionGeneration
      if (isLatestSelection) {
        selectingSource = false
      }
    }
  })

  addHandler('controlCharacterSearch', (event, ...args) => {
    requireSearchSender(event)
    const control = parseSearchControl(args)
    const hasValidControl = control != null
    if (!hasValidControl) {
      return lifetime.result('INVALID_SEARCH_COMMAND')
    }
    const isRead = control.action === 'read'
    if (isRead) {
      return lifetime.result()
    }
    const isEnd = control.action === 'end'
    if (isEnd) {
      return lifetime.end(control.captureId)
    }

    const generation = auth?.captureGeneration()
    const hasPermission = generation != null
    if (!hasPermission) {
      return lifetime.result('SEARCH_NOT_ALLOWED')
    }
    const isClear = control.action === 'clear'
    if (isClear) {
      return lifetime.clear(control)
    }
    const isRetry = control.action === 'retry'
    if (isRetry) {
      return lifetime.retry(control)
    }
    const snapshot = auth!.getSnapshot()
    const hasSameRun = control.authRunId === snapshot.runId
    const hasSameRevision = control.authRevision === snapshot.revision
    const hasCurrentAuth = hasSameRun && hasSameRevision
    if (!hasCurrentAuth) {
      return lifetime.result('STALE_SEARCH')
    }
    const hasCapture = lifetime.current != null
    const isBusy = selectingSource || hasCapture
    if (isBusy) {
      return lifetime.result('SEARCH_BUSY')
    }
    const hasSource = selectedSourceId != null
    if (!hasSource) {
      return lifetime.result('SEARCH_NOT_ALLOWED')
    }
    return lifetime.begin({
      authGeneration: generation,
      windowGeneration,
      sourceGeneration: sourceSelectionGeneration
    })
  })

  addHandler('notifyStableNicknameDetected', (event, ...args) => {
    requireSearchSender(event)
    const observation = parseSearchObservation(args)
    const hasValidObservation = observation != null
    if (!hasValidObservation) {
      return lifetime.result('INVALID_SEARCH_COMMAND')
    }
    const hasPermission = auth?.captureGeneration() != null
    if (!hasPermission) {
      return lifetime.result('SEARCH_NOT_ALLOWED')
    }
    return lifetime.observe(observation)
  })

  return () => {
    unsubscribe?.()
    unsubscribe = undefined
    auth = undefined
    clearSource()
    ipcMain.removeHandler('listCaptureSources')
    ipcMain.removeHandler('selectCaptureSource')
    ipcMain.removeHandler('notifyStableNicknameDetected')
    ipcMain.removeHandler('controlCharacterSearch')
  }
}

function registerCaptureWindow(window: BrowserWindow, rendererDocumentUrl: string): void {
  captureWindow = window
  documentUrl = rendererDocumentUrl
  windowGeneration += 1
  clearSource()
  registerDisplayMediaHandler(window)

  window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    const isCurrentWindow = captureWindow === window
    const shouldInvalidate = isCurrentWindow && isMainFrame
    if (!shouldInvalidate) {
      return
    }
    windowGeneration += 1
    clearSource()
  })
  window.webContents.on('destroyed', () => {
    const isCurrentWindow = captureWindow === window
    if (!isCurrentWindow) {
      return
    }
    windowGeneration += 1
    clearSource()
  })
  window.webContents.on('render-process-gone', () => {
    const isCurrentWindow = captureWindow === window
    if (!isCurrentWindow) {
      return
    }
    windowGeneration += 1
    clearSource()
  })
  window.on('closed', () => {
    const isCurrentWindow = captureWindow === window
    if (!isCurrentWindow) {
      return
    }
    captureWindow = null
    documentUrl = null
    windowGeneration += 1
    clearSource()
  })
}

function deliverMediaResult(
  callback: (streams: Electron.Streams) => void,
  streams: Electron.Streams | null
): void {
  // Electron 39.8.10 native는 null을 CAPTURE_FAILURE로 받지만 공개 Streams type에는 빠져 있다.
  const nativeCallback = callback as (result: Electron.Streams | null) => void
  try {
    nativeCallback(streams)
  } catch {
    // Native once callback은 throw 전에 소비될 수 있으므로 재호출하지 않는다.
  }
}

function registerDisplayMediaHandler(window: BrowserWindow): void {
  window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    const generation = auth?.captureGeneration()
    const startedWindowGeneration = windowGeneration
    const selectionGeneration = sourceSelectionGeneration
    const sourceId = selectedSourceId
    const binding = search?.current
    const hasCapture = binding != null
    const hasPermission = generation != null
    const hasSource = sourceId != null
    const isTrusted = isTrustedFrame(window, request.frame)
    const isRequestAllowed = isCaptureRequestAllowed({
      hasSelectedSource: hasSource,
      isMainFrame: isTrusted,
      videoRequested: request.videoRequested,
      audioRequested: request.audioRequested,
      userGesture: request.userGesture
    })
    const hasSameAuth = hasCapture && binding.authGeneration === generation
    const hasSameWindow = hasCapture && binding.windowGeneration === startedWindowGeneration
    const hasSameSource = hasCapture && binding.sourceGeneration === selectionGeneration
    const hasCurrentCapture = hasCapture && hasSameAuth && hasSameWindow && hasSameSource
    const isAllowed = hasPermission && hasSource && isRequestAllowed && hasCurrentCapture
    if (!isAllowed) {
      deliverMediaResult(callback, null)
      return
    }
    const captureId = binding.captureId
    void getWindowSources()
      .then((sources) => {
        const isCurrent = isCurrentCapture(generation, startedWindowGeneration)
        const isStillTrusted = isTrustedFrame(window, request.frame)
        const hasSameSelection = selectionGeneration === sourceSelectionGeneration
        const hasSameCapture = search?.current?.captureId === binding?.captureId
        const canAllow = isCurrent && isStillTrusted && hasSameSelection && hasSameCapture
        const source = canAllow ? findSelectedSource(sources, sourceId) : null
        const hasSource = source != null
        if (!hasSource) {
          search?.end(captureId)
        }
        deliverMediaResult(callback, hasSource ? { video: source } : null)
      })
      .catch(() => {
        search?.end(captureId)
        deliverMediaResult(callback, null)
      })
  })
}

export { registerCaptureIpc, registerCaptureWindow }
