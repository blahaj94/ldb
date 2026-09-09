import { app, BrowserWindow, session } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'node:url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { validateDevRendererUrl } from './renderer-document'
import { registerCaptureIpc, registerCaptureWindow } from './capture/ipc-handler'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
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
  registerCaptureWindow(window, rendererDocumentUrl)

  window.on('closed', () => {
    const isCurrentWindow = mainWindow === window
    if (isCurrentWindow) {
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

  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  registerCaptureIpc()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    const hasNoOpenWindows = BrowserWindow.getAllWindows().length === 0
    if (hasNoOpenWindows) {
      createWindow()
    }
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  const shouldQuit = process.platform !== 'darwin'
  if (shouldQuit) {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
