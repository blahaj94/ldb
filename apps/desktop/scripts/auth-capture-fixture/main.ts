import { app, BrowserWindow, Menu, session, systemPreferences } from 'electron'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAuthCoordinator } from '../../src/backend/auth/coordinator'
import { registerAuthIpc } from '../../src/backend/auth/ipc-handler'
import { registerObservedCapture } from './capture-observation'
import { canaries, createFixtureEffects, syntheticCode } from '../auth-bridge-fixture/effects'
import { smoke, smokeStandaloneOcr } from './smoke'
import { registerFixtureMediaPermissions } from './permissions'
import { createFixtureSearch, searchScenarios, type SearchScenario } from './search-effects'

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
const isDenyMedia = process.argv.includes('--deny-media')
if (canStart) {
  app.setPath('userData', profile)
  app.setName('LDB Auth Capture fixture')
  app.on('window-all-closed', () => app.quit())

  app
    .whenReady()
    .then(async () => {
      const effects = createFixtureEffects()
      const coordinator = createAuthCoordinator(effects.dependencies)
      const search = createFixtureSearch(effects.dependencies)
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
      if (isDenyMedia) {
        session.defaultSession.setPermissionCheckHandler(() => false)
        session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
          callback(false)
        )
      } else {
        registerFixtureMediaPermissions(window, documentUrl, coordinator)
      }
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
      const captureObservation = registerObservedCapture(
        coordinator,
        window,
        documentUrl,
        search.runtime
      )
      window.on('closed', () => {
        currentWindow = null
        disposeAuth()
        captureObservation.dispose()
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
              ...Object.entries(searchScenarios).map(([scenario, label]) => ({
                label,
                click: () => search.selectScenario(scenario as SearchScenario)
              })),
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
        'Capture fixture ready: synthetic source; memory-only auth; approved synthetic media only; native credentials/network disabled'
      )
      console.log(
        `Capture fixture screen permission: ${systemPreferences.getMediaAccessStatus('screen')}`
      )
      const runsAutomatically = isAuto || isOcr || isDenyMedia
      if (runsAutomatically) {
        const deadline = setTimeout(() => {
          console.error('Capture fixture timeout FAIL')
          app.exit(1)
        }, 90_000)
        try {
          if (isOcr) await smokeStandaloneOcr(window)
          else await smoke(window, coordinator, completeLogin, captureObservation.counts)
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
