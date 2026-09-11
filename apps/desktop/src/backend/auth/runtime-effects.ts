import { randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { EventEmitter } from 'node:events'
import { dialog, safeStorage as electronSafeStorage, shell, type SafeStorage } from 'electron'
import { createAuthHttpClient } from './http'
import { createMacOsCredentialStore } from './credential-store/macos-credential-store'
import type { AuthClock, AuthCoordinatorDependencies } from './types'
import type { AuthRuntimeConfig } from './runtime-config'
import { createRuntimeClock, type ClockPowerState } from './runtime-clock'

type RuntimeEffectsOptions = Readonly<{
  safeStorage?: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>
  platform?: NodeJS.Platform
  fetch?: typeof globalThis.fetch
  showMessageBox?: () => Promise<unknown>
  openExternal?: (url: string) => Promise<void>
  readWallMs?: () => number
  readMonotonicMs?: () => number
  createStore?: typeof createMacOsCredentialStore
  createHttp?: typeof createAuthHttpClient
}>

export type AuthRuntimeEffects = Readonly<{
  announceCredentialAccess(): Promise<void>
  createDependencies(config: AuthRuntimeConfig): AuthCoordinatorDependencies
  createSearchClock(): AuthClock
}>

type RuntimePowerEffects = Readonly<{
  bindPowerMonitor(powerMonitor: Pick<EventEmitter, 'on' | 'removeListener'>): () => void
}>

export function createAuthRuntimeEffects(
  options: RuntimeEffectsOptions = {}
): AuthRuntimeEffects & RuntimePowerEffects {
  const safeStorage = options.safeStorage ?? electronSafeStorage
  const platform = options.platform ?? process.platform
  const createStore = options.createStore ?? createMacOsCredentialStore
  const createHttp = options.createHttp ?? createAuthHttpClient
  const openExternal =
    options.openExternal ??
    shell?.openExternal ??
    (async () => {
      throw new Error('External browser is unavailable.')
    })
  const readWallMs = options.readWallMs ?? Date.now
  const readMonotonicMs = options.readMonotonicMs ?? (() => performance.now())
  const powerState: ClockPowerState = { suspended: false, revision: 0 }
  const showMessageBox =
    options.showMessageBox ??
    (() =>
      dialog.showMessageBox({
        type: 'info',
        title: 'LDB',
        message: '로그인 상태를 확인하기 전에 이 기기의 안전한 저장소에 접근합니다.',
        buttons: ['확인']
      }))

  return {
    bindPowerMonitor(powerMonitor): () => void {
      const suspend = (): void => {
        powerState.suspended = true
        powerState.revision += 1
      }
      const resume = (): void => {
        powerState.suspended = false
        powerState.revision += 1
      }
      const dispose = (): void => {
        powerMonitor.removeListener('suspend', suspend)
        powerMonitor.removeListener('resume', resume)
      }
      try {
        powerMonitor.on('suspend', suspend)
        powerMonitor.on('resume', resume)
      } catch (error) {
        dispose()
        throw error
      }
      return dispose
    },

    async announceCredentialAccess(): Promise<void> {
      await showMessageBox()
    },

    createDependencies(config: AuthRuntimeConfig): AuthCoordinatorDependencies {
      const apiOrigin = config.apiOrigin
      const http = createHttp({ apiOrigin, fetch: options.fetch })
      const store = createStore({
        userDataPath: config.userDataPath,
        context: {
          environment: config.environment,
          apiOrigin,
          clientId: 'desktop'
        },
        safeStorage,
        platform
      })
      const clock = createRuntimeClock({ readWallMs, readMonotonicMs, powerState })

      return {
        providers: config.providers,
        apiOrigin,
        returnTarget: config.returnTarget,
        browser: { open: openExternal },
        clock,
        entropy: {
          uuid: randomUUID,
          bytes: (size) => randomBytes(size)
        },
        http,
        store
      }
    },

    createSearchClock(): AuthClock {
      return createRuntimeClock({ readWallMs, readMonotonicMs, powerState })
    }
  }
}

export type { RuntimeEffectsOptions }
