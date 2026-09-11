import { app, BrowserWindow, Menu, session } from 'electron'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAuthCoordinator } from '../../src/backend/auth/coordinator'
import { registerAuthIpc } from '../../src/backend/auth/ipc-handler'
import { canaries, createFixtureEffects, syntheticCode } from './effects'
import { smoke } from './smoke'

const profile = process.env.LDB_AUTH_BRIDGE_PROFILE
const launcherPid = process.env.LDB_AUTH_BRIDGE_LAUNCHER_PID
const hasProfile = profile != null
const hasExpectedDirectory = hasProfile && dirname(profile) === tmpdir()
const hasOwnedName =
  hasProfile && /^ldb-auth-bridge-fixture-[A-Za-z0-9]{6}$/.test(basename(profile))
const isLauncherChild = launcherPid === String(process.ppid)
const canStart = hasProfile && hasExpectedDirectory && hasOwnedName && isLauncherChild
const isAuto = process.argv.includes('--smoke')
if (canStart) {
  app.setPath('userData', profile)
  app.setName('LDB Auth Bridge fixture')
  let failed = false
  app.on('window-all-closed', () => app.quit())

  app
    .whenReady()
    .then(async () => {
      session.defaultSession.setPermissionCheckHandler(() => false)
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false)
      )
      session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const isLocal = details.url.startsWith('file:')
        callback({ cancel: !isLocal })
      })
      const effects = createFixtureEffects()
      const coordinator = createAuthCoordinator(effects.dependencies)
      await coordinator.start()
      const window = new BrowserWindow({
        title: 'LDB Auth Bridge fixture',
        width: 1100,
        height: 800,
        webPreferences: {
          preload: resolve(__dirname, '../preload/preload.cjs'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      const entry = resolve(__dirname, '../renderer/index.html')
      let currentWindow: BrowserWindow | null = window
      const dispose = registerAuthIpc({
        coordinator,
        getWindow: () => currentWindow,
        documentUrl: pathToFileURL(entry).href
      })
      window.on('closed', () => {
        currentWindow = null
        dispose()
      })
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event) => event.preventDefault())
      window.webContents.on('console-message', (_event, _level, message) => {
        const hasCanary = canaries.some((canary) => message.includes(canary))
        if (hasCanary) {
          failed = true
        }
      })
      const completeLogin = async (): Promise<void> => {
        await coordinator.handleReturnUrl(
          `${effects.dependencies.returnTarget}?code=${syntheticCode}`
        )
      }
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Fixture',
            submenu: [
              {
                label: 'Complete login',
                click: () => {
                  void completeLogin()
                }
              },
              { role: 'reload' },
              { role: 'quit' }
            ]
          }
        ])
      )
      await window.loadFile(entry)
      console.log(
        'Auth bridge fixture ready: fake effects; network/media/native credentials disabled'
      )
      if (isAuto) {
        try {
          await smoke(window, coordinator, effects)
          if (failed) {
            throw new Error('Fixture canary detected')
          }
          console.log('Auth bridge fixture smoke PASS')
          app.quit()
        } catch {
          console.error('Auth bridge fixture smoke FAIL')
          app.exit(1)
        }
      }
    })
    .catch(() => {
      console.error('Auth bridge fixture startup FAIL')
      app.exit(1)
    })
} else {
  console.error('Auth bridge fixture requires the Node launcher')
  app.exit(1)
}
