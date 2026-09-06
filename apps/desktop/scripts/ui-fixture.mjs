import { app, BrowserWindow, ipcMain, nativeTheme, session } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2] ?? 'desktop'
const theme = process.argv[3] ?? 'system'
const isModeValid = ['desktop', 'example'].includes(mode)
const isThemeValid = ['system', 'light', 'dark'].includes(theme)
const isInputInvalid = !isModeValid || !isThemeValid
if (isInputInvalid) throw new Error('Use desktop|example and system|light|dark')

const userData = mkdtempSync(join(tmpdir(), 'ldb-ui-fixture-'))
app.setPath('userData', userData)
app.setName('LDB UI fixture')
nativeTheme.themeSource = theme
app.on('window-all-closed', () => app.quit())
app.on('quit', () => rmSync(userData, { recursive: true, force: true }))

app.whenReady().then(async () => {
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )

  const window = new BrowserWindow({
    title: `LDB UI fixture — ${mode} · ${theme}`,
    width: 1100,
    height: 800,
    show: false,
    webPreferences: {
      preload: fileURLToPath(
        new URL('../node_modules/.tmp/ui-fixture/ui-fixture-preload.cjs', import.meta.url)
      ),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  window.on('page-title-updated', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const isolated = new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error('UI fixture isolation was not confirmed')),
      5000
    )
    ipcMain.once('ui-fixture-ready', (event) => {
      const isExpectedRenderer = event.sender === window.webContents
      if (!isExpectedRenderer) return
      clearTimeout(deadline)
      resolve()
    })
  })
  const isExample = mode === 'example'
  const target = isExample
    ? new URL('../../../packages/ui/dist-examples/index.html', import.meta.url)
    : new URL('../out/frontend/index.html', import.meta.url)

  try {
    await Promise.all([window.loadFile(fileURLToPath(target)), isolated])
    window.show()
    console.log(`UI fixture ready: ${mode}, ${theme}; native media disabled`)
  } catch (error) {
    window.destroy()
    app.quit()
    throw error
  }
})
