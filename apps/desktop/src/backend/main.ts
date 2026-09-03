import { app, shell, BrowserWindow, desktopCapturer, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { findSelectedSource, isCaptureRequestAllowed } from './capture-policy'

let mainWindow: BrowserWindow | null = null
let selectedSourceId: string | null = null
let sourceSelectionGeneration = 0

async function getWindowSources(): Promise<Electron.DesktopCapturerSource[]> {
  return desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  })
}

function isMainRenderer(sender: Electron.WebContents): boolean {
  return sender === mainWindow?.webContents
}

function registerCaptureIpc(): void {
  ipcMain.handle('capture:list-sources', async (event) => {
    if (!isMainRenderer(event.sender)) throw new Error('Capture source access denied')

    const sources = await getWindowSources()
    return sources.map(({ id, name }) => ({ id, name }))
  })

  ipcMain.handle('capture:select-source', async (event, sourceId: unknown) => {
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

  ipcMain.on('capture:stable-nickname', (event, value: unknown) => {
    if (!isMainRenderer(event.sender) || !isStableNickname(value)) return

    console.info('Stable party nickname detected', value)
  })
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

function createWindow(): void {
  // Create the browser window.
  const window = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      backgroundThrottling: false,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow = window
  registerDisplayMediaHandler(window)

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
      selectedSourceId = null
      sourceSelectionGeneration += 1
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../frontend/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerCaptureIpc()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
