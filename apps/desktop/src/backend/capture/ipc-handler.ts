import {
  desktopCapturer,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type WebFrameMain
} from 'electron'
import { addHandler } from '../ipc'
import type { AuthCoordinator } from '../auth/types'
import { findSelectedSource, isCaptureRequestAllowed } from './capture-policy'

let captureWindow: BrowserWindow | null = null
let documentUrl: string | null = null
let windowGeneration = 0
let sourceSelectionGeneration = 0
let selectedSourceId: string | null = null
let auth: AuthCoordinator | undefined
let unsubscribe: (() => void) | undefined

async function getWindowSources(): Promise<Electron.DesktopCapturerSource[]> {
  return desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  })
}

function clearSource(): void {
  selectedSourceId = null
  sourceSelectionGeneration += 1
}

function isTrustedFrame(window: BrowserWindow | null, frame: WebFrameMain | null): boolean {
  const isRegisteredWindow = window != null && window === captureWindow
  const isWindowAlive =
    isRegisteredWindow && !window.isDestroyed() && !window.webContents.isDestroyed()
  if (!isWindowAlive) return false
  const isMainFrame = frame != null && frame === window.webContents.mainFrame
  const hasExactDocument = isMainFrame && !frame.isDestroyed() && frame.url === documentUrl
  return hasExactDocument
}

function requireSender(event: IpcMainInvokeEvent, expected = captureWindow): void {
  const isTrusted = isTrustedFrame(expected, event.senderFrame)
  const isSender = event.sender === expected?.webContents
  const isAllowed = isTrusted && isSender
  if (!isAllowed) throw new Error('Capture source access denied')
}

function requireCaptureGeneration(): number {
  const generation = auth?.captureGeneration()
  const hasPermission = generation != null
  if (!hasPermission) throw new Error('Capture source access denied')
  return generation
}

function isCurrentCapture(generation: number, startedWindowGeneration: number): boolean {
  const hasSameAuth = auth?.captureGeneration() === generation
  const hasSameWindow = windowGeneration === startedWindowGeneration
  const isCurrent = hasSameAuth && hasSameWindow
  return isCurrent
}

function isStableNickname(value: unknown): value is { slot: number; nickname: string } {
  const isObject = value != null && typeof value === 'object'
  if (!isObject) return false
  const { slot, nickname } = value as { slot?: unknown; nickname?: unknown }
  const isSlotNumber = typeof slot === 'number'
  const isSlotInteger = isSlotNumber && Number.isInteger(slot)
  const isSlotInRange = isSlotInteger && slot >= 0 && slot < 4
  const isNicknameString = typeof nickname === 'string'
  const isValid = isSlotInRange && isNicknameString
  return isValid
}

function registerCaptureIpc(coordinator?: AuthCoordinator): () => void {
  unsubscribe?.()
  auth = coordinator
  clearSource()
  unsubscribe = auth?.subscribe(() => {
    const isUnauthorized = auth?.captureGeneration() == null
    if (isUnauthorized) clearSource()
  })

  addHandler('listCaptureSources', async (event) => {
    const window = captureWindow
    const startedWindowGeneration = windowGeneration
    requireSender(event, window)
    const generation = requireCaptureGeneration()
    const sources = await getWindowSources()
    requireSender(event, window)
    const isCurrent = isCurrentCapture(generation, startedWindowGeneration)
    if (!isCurrent) throw new Error('Capture source access denied')
    return sources.map(({ id, name }) => ({ id, name }))
  })

  addHandler('selectCaptureSource', async (event, sourceId) => {
    const window = captureWindow
    const startedWindowGeneration = windowGeneration
    requireSender(event, window)
    const isSourceIdString = typeof sourceId === 'string'
    if (!isSourceIdString) throw new Error('Capture source selection denied')
    const isCleanup = sourceId.length === 0
    if (isCleanup) {
      clearSource()
      return null
    }
    const generation = requireCaptureGeneration()
    const selectionGeneration = ++sourceSelectionGeneration
    const source = findSelectedSource(await getWindowSources(), sourceId)
    requireSender(event, window)
    const isCurrent = isCurrentCapture(generation, startedWindowGeneration)
    if (!isCurrent) throw new Error('Capture source selection denied')
    const isLatestSelection = selectionGeneration === sourceSelectionGeneration
    if (!isLatestSelection) return null
    const hasSource = source != null
    if (!hasSource) throw new Error('Selected capture source is no longer available')
    selectedSourceId = source.id
    return { id: source.id, name: source.name }
  })

  addHandler('notifyStableNicknameDetected', (event, value) => {
    requireSender(event)
    requireCaptureGeneration()
    const isValid = isStableNickname(value)
    if (!isValid) return
    // 검색 연결 전까지 전달값을 보관하거나 진단 log에 기록하지 않는다.
  })

  return () => {
    unsubscribe?.()
    unsubscribe = undefined
    auth = undefined
    clearSource()
    ipcMain.removeHandler('listCaptureSources')
    ipcMain.removeHandler('selectCaptureSource')
    ipcMain.removeHandler('notifyStableNicknameDetected')
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
    if (!shouldInvalidate) return
    windowGeneration += 1
    clearSource()
  })
  window.on('closed', () => {
    const isCurrentWindow = captureWindow === window
    if (!isCurrentWindow) return
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
    const isAllowed = hasPermission && hasSource && isRequestAllowed
    if (!isAllowed) {
      deliverMediaResult(callback, null)
      return
    }
    void getWindowSources()
      .then((sources) => {
        const isCurrent = isCurrentCapture(generation, startedWindowGeneration)
        const isStillTrusted = isTrustedFrame(window, request.frame)
        const hasSameSelection = selectionGeneration === sourceSelectionGeneration
        const canAllow = isCurrent && isStillTrusted && hasSameSelection
        const source = canAllow ? findSelectedSource(sources, sourceId) : null
        const hasSource = source != null
        deliverMediaResult(callback, hasSource ? { video: source } : null)
      })
      .catch(() => deliverMediaResult(callback, null))
  })
}

export { registerCaptureIpc, registerCaptureWindow }
