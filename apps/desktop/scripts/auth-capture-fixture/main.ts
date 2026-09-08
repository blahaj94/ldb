import { app, BrowserWindow, Menu, session, systemPreferences } from 'electron'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAuthCoordinator } from '../../src/backend/auth/coordinator'
import { registerAuthIpc } from '../../src/backend/auth/ipc-handler'
import { registerCaptureIpc, registerCaptureWindow } from '../../src/backend/capture/ipc-handler'
import { canaries, createFixtureEffects, syntheticCode } from '../auth-bridge-fixture/effects'
import { smoke, smokeStandaloneOcr } from './smoke'

const profile = process.env.LDB_AUTH_CAPTURE_PROFILE
const launcherPid = process.env.LDB_AUTH_CAPTURE_LAUNCHER_PID
const hasProfile = profile != null
const hasExpectedDirectory = hasProfile && dirname(profile) === tmpdir()
const hasOwnedName =
  hasProfile && /^ldb-auth-capture-fixture-[A-Za-z0-9]{6}$/.test(basename(profile))
const isLauncherChild = launcherPid === String(process.ppid)
const canStart = hasExpectedDirectory && hasOwnedName && isLauncherChild
const isAuto = process.argv.includes('--smoke')
const isOcr = process.argv.includes('--ocr')
if (canStart) {
  app.setPath('userData', profile)
  app.setName('LDB Auth Capture fixture')
  app.on('window-all-closed', () => app.quit())

  app
    .whenReady()
    .then(async () => {
      const effects = createFixtureEffects()
      const coordinator = createAuthCoordinator(effects.dependencies)
      await coordinator.start()
      const window = new BrowserWindow({
        title: 'LDB Auth Capture fixture',
        width: 1100,
        height: 800,
        webPreferences: {
          preload: resolve(__dirname, '../preload/preload.cjs'),
          backgroundThrottling: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      const source = new BrowserWindow({
        title: 'LDB Synthetic Capture Source',
        width: 1920,
        height: 1080,
        useContentSize: true,
        enableLargerThanScreen: true,
        frame: false,
        webPreferences: {
          backgroundThrottling: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      const entry = resolve(__dirname, '../renderer/index.html')
      const documentUrl = pathToFileURL(entry).href
      session.defaultSession.setPermissionCheckHandler(() => false)
      // Pinned Electron은 display와 legacy desktop을 mediaTypes:[]로 함께 전달한다.
      // 구별 수단이 승인되기 전에는 어느 경로에도 native media를 허용하지 않는다.
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false)
      )
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const isLocal = details.url.startsWith('file:')
        callback({ cancel: !isLocal })
      })
      let currentWindow: BrowserWindow | null = window
      const disposeAuth = registerAuthIpc({
        coordinator,
        getWindow: () => currentWindow,
        documentUrl
      })
      const disposeCapture = registerCaptureIpc(coordinator)
      registerCaptureWindow(window, documentUrl)
      window.on('closed', () => {
        currentWindow = null
        disposeAuth()
        disposeCapture()
        source.destroy()
      })
      let hasCanary = false
      for (const target of [window, source]) {
        target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        target.webContents.on('will-navigate', (event) => event.preventDefault())
        target.webContents.on('console-message', (_event, _level, message) => {
          const includesCanary = canaries.some((canary) => message.includes(canary))
          if (includesCanary) hasCanary = true
        })
      }
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
              { label: 'Show capture app', click: () => window.show() },
              { label: 'Show synthetic source', click: () => source.show() },
              { label: 'Quit LDB Auth Capture fixture', click: () => app.quit() }
            ]
          }
        ])
      )
      await source.loadFile(resolve(__dirname, '../renderer/source.html'))
      await window.loadFile(entry)
      window.show()
      console.log(
        'Capture fixture ready: synthetic source; memory-only auth; native media/credentials/network disabled'
      )
      console.log(
        `Capture fixture screen permission: ${systemPreferences.getMediaAccessStatus('screen')}`
      )
      const runsAutomatically = isAuto || isOcr
      if (runsAutomatically) {
        const deadline = setTimeout(() => {
          console.error('Capture fixture timeout FAIL')
          app.exit(1)
        }, 90_000)
        try {
          if (isOcr) await smokeStandaloneOcr(window)
          else await smoke(window, coordinator, completeLogin)
          if (hasCanary) throw new Error('Capture fixture canary detected')
          console.log(isOcr ? 'Capture fixture standalone OCR PASS' : 'Capture fixture smoke PASS')
          app.quit()
        } catch {
          const observation = await window.webContents
            .executeJavaScript('window.captureObservation?.()')
            .catch(() => null)
          console.log(`Capture fixture counters: ${JSON.stringify(observation)}`)
          console.error(
            isOcr
              ? 'Capture fixture standalone OCR FAIL'
              : 'Capture fixture media BLOCKED / smoke FAIL'
          )
          app.exit(1)
        } finally {
          clearTimeout(deadline)
        }
      }
    })
    .catch(() => {
      console.error('Capture fixture startup FAIL')
      app.exit(1)
    })
} else {
  console.error('Capture fixture requires the Node launcher')
  app.exit(1)
}
