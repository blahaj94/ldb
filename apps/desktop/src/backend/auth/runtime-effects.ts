import { randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { dialog, safeStorage as electronSafeStorage, shell, type SafeStorage } from 'electron'
import { createAuthHttpClient } from './http'
import { createMacOsCredentialStore } from './credential-store/macos-credential-store'
import type { AuthClock, AuthCoordinatorDependencies } from './types'
import type { AuthRuntimeConfig } from './runtime-config'

type RuntimeEffectsOptions = Readonly<{
  config: AuthRuntimeConfig
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
  createDependencies(): AuthCoordinatorDependencies
  createSearchClock(): AuthClock
}>

function createClock(readWallMs: () => number, readMonotonicMs: () => number): AuthClock {
  let previousWallMs = readWallMs()
  let previousMonotonicMs = readMonotonicMs()

  return {
    read: () => {
      const wallMs = readWallMs()
      const monotonicMs = readMonotonicMs()
      const movedWallBack = previousWallMs != null && wallMs < previousWallMs
      const movedMonotonicBack = previousMonotonicMs != null && monotonicMs < previousMonotonicMs
      previousWallMs = wallMs
      previousMonotonicMs = monotonicMs

      return {
        wallMs,
        monotonicMs,
        discontinuous: movedWallBack || movedMonotonicBack
      }
    },
    schedule: (delayMs, callback) => {
      const timeout = setTimeout(callback, delayMs)
      return () => clearTimeout(timeout)
    }
  }
}

export function createAuthRuntimeEffects(options: RuntimeEffectsOptions): AuthRuntimeEffects {
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
        userDataPath: options.config.userDataPath,
        context: {
          environment: options.config.environment,
          apiOrigin,
          clientId: 'desktop'
        },
        safeStorage,
        platform
      })
      const clock = createClock(readWallMs, readMonotonicMs)

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
    },

    createSearchClock(): AuthClock {
      return createClock(readWallMs, readMonotonicMs)
    }
  }
}

export type { RuntimeEffectsOptions }
