import { randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  app as electronApp,
  dialog,
  safeStorage as electronSafeStorage,
  shell,
  type App,
  type SafeStorage
} from 'electron'
import { createAuthHttpClient } from './http'
import { createMacOsCredentialStore } from './credential-store/macos-credential-store'
import type { AuthClock, AuthCoordinatorDependencies } from './types'
import type { AuthRuntimeConfig } from './runtime-config'

type RuntimeEffectsOptions = Readonly<{
  config: AuthRuntimeConfig
  app?: Pick<App, 'getPath'>
  safeStorage?: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>
  platform?: NodeJS.Platform
  fetch?: typeof globalThis.fetch
  showMessageBox?: () => Promise<unknown>
  openExternal?: (url: string) => Promise<void>
  createStore?: typeof createMacOsCredentialStore
  createHttp?: typeof createAuthHttpClient
}>

export type AuthRuntimeEffects = Readonly<{
  announceCredentialAccess(): Promise<void>
  createDependencies(): AuthCoordinatorDependencies
}>

function createClock(): AuthClock {
  return {
    read: () => ({
      wallMs: Date.now(),
      monotonicMs: performance.now(),
      discontinuous: false
    }),
    schedule: (delayMs, callback) => {
      const timeout = setTimeout(callback, delayMs)
      return () => clearTimeout(timeout)
    }
  }
}

export function createAuthRuntimeEffects(options: RuntimeEffectsOptions): AuthRuntimeEffects {
  const application = options.app ?? electronApp
  const safeStorage = options.safeStorage ?? electronSafeStorage
  const platform = options.platform ?? process.platform
  const createStore = options.createStore ?? createMacOsCredentialStore
  const createHttp = options.createHttp ?? createAuthHttpClient
  const openExternal = options.openExternal ?? shell.openExternal
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
    async announceCredentialAccess(): Promise<void> {
      await showMessageBox()
    },

    createDependencies(): AuthCoordinatorDependencies {
      const apiOrigin = options.config.apiOrigin
      const http = createHttp({ apiOrigin, fetch: options.fetch })
      const store = createStore({
        userDataPath: application.getPath('userData'),
        context: {
          environment: options.config.environment,
          apiOrigin,
          clientId: 'desktop'
        },
        safeStorage,
        platform
      })
      const clock = createClock()

      return {
        providers: options.config.providers,
        apiOrigin,
        returnTarget: options.config.returnTarget,
        browser: { open: openExternal },
        clock,
        entropy: {
          uuid: randomUUID,
          bytes: (size) => randomBytes(size)
        },
        http,
        store
      }
    }
  }
}

export type { RuntimeEffectsOptions }
