import type { AuthCoordinatorDependencies } from '../../src/backend/auth/types'

// 실제 credential이 아닌 fixture 전용 canary. 값은 진단 출력에 기록하지 않는다.
export const syntheticCode = Buffer.alloc(32, 9).toString('base64url')
const refreshToken = Buffer.alloc(32, 12).toString('base64url')
const accessToken = 'synthetic.payload.signature'
const browserUrl = `https://api.example.test/auth/login/authorize?ticket=${Buffer.alloc(32, 8).toString('base64url')}`
export const canaries = [
  syntheticCode,
  refreshToken,
  accessToken,
  browserUrl,
  Buffer.alloc(32, 2).toString('base64url')
]

type Effects = {
  dependencies: AuthCoordinatorDependencies
  counts: { browser: number; exchange: number; logout: number; commit: number }
  holdCommit: () => void
  releaseCommit: () => void
}

export function createFixtureEffects(): Effects {
  let sequence = 0
  let committed = false
  let marked = false
  let heldCommit: Promise<void> | null = null
  let releaseCommit = (): void => {}
  const counts = { browser: 0, exchange: 0, logout: 0, commit: 0 }
  const started = performance.now()
  const wallStart = Date.parse('2030-01-01T00:00:00.000Z')
  const wallNow = (): number => wallStart + performance.now() - started
  const dependencies: AuthCoordinatorDependencies = {
    providers: ['google', 'discord'],
    apiOrigin: 'https://api.example.test',
    returnTarget: 'ldb-fixture://auth/return',
    clock: {
      read: () => ({
        wallMs: wallNow(),
        monotonicMs: performance.now() - started,
        discontinuous: false
      }),
      schedule: (delay, callback) => {
        const timer = setTimeout(callback, delay)
        return () => clearTimeout(timer)
      }
    },
    entropy: {
      uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
      bytes: (size) => {
        const bytes = Buffer.alloc(size, ++sequence)
        canaries.push(bytes.toString('base64url'))
        return bytes
      }
    },
    browser: {
      open: async () => {
        counts.browser += 1
      }
    },
    http: {
      createLoginRequest: async () => ({
        requestId: '10000000-0000-4000-8000-000000000001',
        browserUrl,
        expiresAt: new Date(wallNow() + 600_000).toISOString()
      }),
      exchange: async () => {
        counts.exchange += 1
        return {
          tokenType: 'Bearer',
          accessToken,
          refreshToken,
          accessTokenExpiresAt: new Date(wallNow() + 900_000).toISOString(),
          sessionExpiresAt: new Date(wallNow() + 2_592_000_000).toISOString(),
          user: { id: '20000000-0000-4000-8000-000000000001', nickname: '중립모험가' },
          isNewUser: true
        }
      },
      logout: async () => {
        counts.logout += 1
      },
      refresh: async () => {
        throw new Error('Fixture does not restore credentials')
      },
      me: async () => {
        throw new Error('Fixture does not restore credentials')
      }
    },
    store: {
      inspect: async () => {
        if (marked) {
          return { status: 'recovery-required' }
        }
        if (committed) {
          return { status: 'ready', refreshToken }
        }
        return { status: 'empty' }
      },
      establishTransition: async () => {
        marked = true
        return 'confirmed'
      },
      commitCredential: async () => {
        counts.commit += 1
        await heldCommit
        committed = true
        return 'confirmed'
      },
      clearCredential: async () => {
        committed = false
        return 'confirmed'
      },
      removeTransition: async () => {
        marked = false
        return 'confirmed'
      },
      reestablishTransition: async () => {
        marked = true
        return 'confirmed'
      }
    }
  }
  return {
    dependencies,
    counts,
    holdCommit: () => {
      heldCommit = new Promise((resolve) => {
        releaseCommit = resolve
      })
    },
    releaseCommit: () => {
      releaseCommit()
      heldCommit = null
    }
  }
}
