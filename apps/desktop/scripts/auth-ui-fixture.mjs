import { app, BrowserWindow, Menu, nativeTheme, session } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const theme = process.argv[2] ?? 'light'
const isThemeValid = ['light', 'dark', 'system'].includes(theme)
if (!isThemeValid) throw new Error('Use light|dark|system')
const userData = mkdtempSync(join(tmpdir(), 'ldb-auth-ui-fixture-'))
app.setPath('userData', userData)
app.setName('LDB Auth UI fixture')
nativeTheme.themeSource = theme
app.on('window-all-closed', () => app.quit())
app.on('quit', () => rmSync(userData, { recursive: true, force: true, maxRetries: 3 }))

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const isLocalFile = details.url.startsWith('file:')
    const isBuiltInDevTools = details.url.startsWith('devtools:')
    const isLocalResource = isLocalFile || isBuiltInDevTools
    callback({ cancel: !isLocalResource })
  })
  const window = new BrowserWindow({
    title: 'LDB Auth UI fixture',
    width: 1100,
    height: 800,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  const entry = fileURLToPath(new URL('../out/auth-ui-fixture/index.html', import.meta.url))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const states = [
    'signedOut',
    'startingLogin',
    'waitingBrowser',
    'invalidReturn',
    'exchanging',
    'restoring',
    'restorePaused',
    'welcome',
    'home',
    'longNickname',
    'signingOut',
    'storageBlocked',
    'noProviders'
  ]
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Fixture',
        submenu: [
          ...states.map((state) => ({
            label: state,
            click: () => window.loadFile(entry, { query: { state } })
          })),
          { type: 'separator' },
          {
            label: 'Light',
            click: () => {
              nativeTheme.themeSource = 'light'
            }
          },
          {
            label: 'Dark',
            click: () => {
              nativeTheme.themeSource = 'dark'
            }
          },
          { label: 'Narrow 360', click: () => window.setContentSize(360, 740) },
          { label: 'Wide 1100', click: () => window.setContentSize(1100, 770) },
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { role: 'quit' }
        ]
      }
    ])
  )
  await window.loadFile(entry, { query: { state: 'signedOut' } })
  console.log(`Auth UI fixture ready: ${theme}; no preload, auth, network or media`)
})
