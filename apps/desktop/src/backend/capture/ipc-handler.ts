import { desktopCapturer, type BrowserWindow, type WebContents } from 'electron'
import { addHandler } from '../ipc'
import { findSelectedSource, isCaptureRequestAllowed } from './capture-policy'

let captureWindow: BrowserWindow | null = null
let sourceSelectionGeneration = 0
let selectedSourceId: string | null = null

async function getWindowSources(): Promise<Electron.DesktopCapturerSource[]> {
  return desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  })
}

function isMainRenderer(sender: WebContents): boolean {
  return sender === captureWindow?.webContents
}

function isStableNickname(value: unknown): value is { slot: number; nickname: string } {
  if (!value || typeof value !== 'object') return false

  const { slot, nickname } = value as { slot?: unknown; nickname?: unknown }
  return (
    Number.isInteger(slot) &&
    typeof slot === 'number' &&
    slot >= 0 &&
    slot < 4 &&
    typeof nickname === 'string'
  )
}

function registerCaptureIpc(): void {
  addHandler('listCaptureSources', async (event) => {
    if (!isMainRenderer(event.sender)) throw new Error('Capture source access denied')

    const sources = await getWindowSources()
    return sources.map(({ id, name }) => ({ id, name }))
  })

  addHandler('selectCaptureSource', async (event, sourceId) => {
    if (!isMainRenderer(event.sender) || typeof sourceId !== 'string') {
      throw new Error('Capture source selection denied')
    }

    const selectionGeneration = ++sourceSelectionGeneration
    if (!sourceId) {
      selectedSourceId = null
      return null
    }

    const source = findSelectedSource(await getWindowSources(), sourceId)
    if (selectionGeneration !== sourceSelectionGeneration) return null
    if (!source) throw new Error('Selected capture source is no longer available')

    selectedSourceId = source.id
    return { id: source.id, name: source.name }
  })

  addHandler('notifyStableNicknameDetected', (event, value) => {
    if (!isMainRenderer(event.sender) || !isStableNickname(value)) return

    console.info('Stable party nickname detected', value)
  })
}

function registerCaptureWindow(window: BrowserWindow): void {
  captureWindow = window
  selectedSourceId = null
  sourceSelectionGeneration += 1
  registerDisplayMediaHandler(window)

  window.on('closed', () => {
    if (captureWindow !== window) return

    captureWindow = null
    selectedSourceId = null
    sourceSelectionGeneration += 1
  })
}

function registerDisplayMediaHandler(window: BrowserWindow): void {
  window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    const allowed = isCaptureRequestAllowed({
      hasSelectedSource: selectedSourceId !== null,
      isMainFrame: request.frame === window.webContents.mainFrame,
      videoRequested: request.videoRequested,
      audioRequested: request.audioRequested,
      userGesture: request.userGesture
    })

    const sourceId = selectedSourceId
    if (!allowed || !sourceId) {
      callback({})
      return
    }

    void getWindowSources()
      .then((sources) => {
        const source = findSelectedSource(sources, sourceId)
        callback(source ? { video: source } : {})
      })
      .catch(() => callback({}))
  })
}

export { registerCaptureIpc, registerCaptureWindow }
