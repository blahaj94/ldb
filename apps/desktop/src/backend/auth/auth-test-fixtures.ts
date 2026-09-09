import { vi } from 'vitest'
import type { MockedFunction } from 'vitest'
import type {
  AuthBrowser,
  AuthClock,
  AuthCoordinatorDependencies,
  AuthEntropy,
  AuthHttp,
  AuthTokens,
  ClockReading,
  CredentialInspection,
  CredentialStore,
  CredentialTransitionKind,
  StoreMutationOutcome
} from './types'

export const RUN_ID = '00000000-0000-4000-8000-000000000001'
export const ATTEMPT_ID = '00000000-0000-4000-8000-000000000002'
export const NEXT_ATTEMPT_ID = '00000000-0000-4000-8000-000000000003'
export const REQUEST_ID = '10000000-0000-4000-8000-000000000001'
export const USER_ID = '20000000-0000-4000-8000-000000000001'
export const RETURN_TARGET = 'ldb-test://auth/return'
export const API_ORIGIN = 'https://api.example.test'
export const CODE = Buffer.alloc(32, 9).toString('base64url')
export const OTHER_CODE = Buffer.alloc(32, 10).toString('base64url')
export const REFRESH_0 = Buffer.alloc(32, 11).toString('base64url')
export const REFRESH_1 = Buffer.alloc(32, 12).toString('base64url')
export const REFRESH_2 = Buffer.alloc(32, 13).toString('base64url')
export const ACCESS_1 = 'next.payload.signature'
export const ACCESS_2 = 'later.payload.signature'

export type Deferred<T> = Readonly<{
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}>

export function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

type TokenResponseInput = Readonly<{
  refreshToken?: string
  accessToken?: string
  accessTokenExpiresAt?: string
}>

export function tokenResponse({
  refreshToken = REFRESH_1,
  accessToken = ACCESS_1,
  accessTokenExpiresAt = '2026-09-06T12:15:00.000Z'
}: TokenResponseInput = {}): AuthTokens {
  return {
    tokenType: 'Bearer',
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
    sessionExpiresAt: '2026-10-06T12:00:00.000Z'
  }
}

type ScheduledTask = {
  readonly at: number
  readonly callback: () => void
  cancelled: boolean
}

export class FakeClock implements AuthClock {
  wallMs = Date.parse('2026-09-06T12:00:00.000Z')
  monotonicMs = 1_000
  discontinuous = false
  readonly scheduled: ScheduledTask[] = []

  read(): ClockReading {
    return {
      wallMs: this.wallMs,
      monotonicMs: this.monotonicMs,
      discontinuous: this.discontinuous
    }
  }

  schedule(delayMs: number, callback: () => void): () => void {
    const task = { at: this.monotonicMs + delayMs, callback, cancelled: false }
    this.scheduled.push(task)

    return () => {
      task.cancelled = true
    }
  }

  advance(milliseconds: number): void {
    this.wallMs += milliseconds
    this.monotonicMs += milliseconds

    const dueTasks = this.scheduled.filter((task) => {
      const isActive = !task.cancelled
      const hasReachedRunTime = isActive && task.at <= this.monotonicMs

      return hasReachedRunTime
    })
    for (const task of dueTasks) {
      task.cancelled = true
      task.callback()
    }
  }

  elapseWithoutTimers(milliseconds: number): void {
    this.wallMs += milliseconds
    this.monotonicMs += milliseconds
  }
}

export class FakeStore implements CredentialStore {
  readonly establishOutcomes: StoreMutationOutcome[] = []
  readonly establishWaits: Promise<StoreMutationOutcome>[] = []
  readonly commitOutcomes: StoreMutationOutcome[] = []
  readonly commitWaits: Promise<StoreMutationOutcome>[] = []
  readonly clearOutcomes: StoreMutationOutcome[] = []
  readonly clearWaits: Promise<StoreMutationOutcome>[] = []
  readonly removeOutcomes: StoreMutationOutcome[] = []
  readonly removeWaits: Promise<StoreMutationOutcome>[] = []
  readonly unknownRemoveApplied: boolean[] = []
  readonly reestablishOutcomes: StoreMutationOutcome[] = []
  private backendUnavailable = false
  private refreshToken: string | null = null
  private marker: CredentialTransitionKind | null = null

  constructor(private readonly operations: string[] = []) {}

  get inspection(): CredentialInspection {
    if (this.backendUnavailable) {
      return { status: 'unavailable' }
    }
    const hasTransitionMarker = this.marker != null
    if (hasTransitionMarker) {
      return { status: 'recovery-required' }
    }
    const refreshToken = this.refreshToken
    const hasRefreshToken = refreshToken != null
    if (hasRefreshToken) {
      return { status: 'ready', refreshToken }
    }
    return { status: 'empty' }
  }

  set inspection(value: CredentialInspection) {
    const isUnavailable = value.status === 'unavailable'
    const requiresRecovery = value.status === 'recovery-required'
    const isReady = value.status === 'ready'
    let readyRefreshToken: string | null = null
    if (isReady) {
      readyRefreshToken = value.refreshToken
    }

    this.backendUnavailable = isUnavailable
    this.marker = requiresRecovery ? 'clear' : null
    this.refreshToken = readyRefreshToken
  }

  get storedRefreshToken(): string | null {
    return this.refreshToken
  }

  get transitionMarker(): CredentialTransitionKind | null {
    return this.marker
  }

  readonly inspect = vi.fn(async () => {
    this.operations.push('store:inspect')
    return this.inspection
  })
  readonly establishTransition = vi.fn(async (kind) => {
    this.operations.push(`store:establish:${kind}`)
    const wait = this.establishWaits.shift()
    const hasWait = wait != null
    const outcome = hasWait ? await wait : this.next(this.establishOutcomes)
    const isConfirmed = outcome === 'confirmed'
    if (isConfirmed) {
      this.marker = kind
    }
    return outcome
  })
  readonly commitCredential = vi.fn(async (refreshToken) => {
    this.operations.push('store:commit')
    const wait = this.commitWaits.shift()
    const hasWait = wait != null
    const outcome = hasWait ? await wait : this.next(this.commitOutcomes)
    const isConfirmed = outcome === 'confirmed'
    if (isConfirmed) {
      this.refreshToken = refreshToken
    }
    return outcome
  })
  readonly clearCredential = vi.fn(async () => {
    this.operations.push('store:clear')
    const wait = this.clearWaits.shift()
    const hasWait = wait != null
    const outcome = hasWait ? await wait : this.next(this.clearOutcomes)
    const isConfirmed = outcome === 'confirmed'
    if (isConfirmed) {
      this.refreshToken = null
    }
    return outcome
  })
  readonly removeTransition = vi.fn(async () => {
    this.operations.push('store:remove')
    const wait = this.removeWaits.shift()
    const hasWait = wait != null
    const outcome = hasWait ? await wait : this.next(this.removeOutcomes)
    const isUnknown = outcome === 'unknown'
    const unknownWasApplied = isUnknown && (this.unknownRemoveApplied.shift() ?? false)
    const isConfirmed = outcome === 'confirmed'
    const markerWasRemoved = isConfirmed || unknownWasApplied
    if (markerWasRemoved) {
      this.marker = null
    }
    return outcome
  })
  readonly reestablishTransition = vi.fn(async (kind) => {
    this.operations.push(`store:reestablish:${kind}`)
    const outcome = this.next(this.reestablishOutcomes)
    const isConfirmed = outcome === 'confirmed'
    if (isConfirmed) {
      this.marker = kind
    }
    return outcome
  })

  private next(outcomes: StoreMutationOutcome[]): StoreMutationOutcome {
    return outcomes.shift() ?? 'confirmed'
  }
}

export type AuthHarness = Readonly<{
  dependencies: AuthCoordinatorDependencies
  browser: Readonly<{ open: MockedFunction<AuthBrowser['open']> }>
  clock: FakeClock
  entropy: AuthEntropy
  operations: string[]
  http: Readonly<{
    value: AuthHttp
    createLoginRequest: MockedFunction<AuthHttp['createLoginRequest']>
    exchange: MockedFunction<AuthHttp['exchange']>
    refresh: MockedFunction<AuthHttp['refresh']>
    logout: MockedFunction<AuthHttp['logout']>
    me: MockedFunction<AuthHttp['me']>
  }>
  store: FakeStore
}>

export function createAuthHarness(): AuthHarness {
  const clock = new FakeClock()
  const operations: string[] = []
  const store = new FakeStore(operations)
  const uuidValues = [RUN_ID, ATTEMPT_ID, NEXT_ATTEMPT_ID]
  const byteValues = [Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3)]

  const entropy: AuthEntropy = {
    uuid: vi.fn(() => uuidValues.shift() ?? '00000000-0000-4000-8000-000000000099'),
    bytes: vi.fn((size) => {
      const bytes = byteValues.shift() ?? Buffer.alloc(32, 99)
      return bytes.subarray(0, size)
    })
  }
  const browser = {
    open: vi.fn(async () => {
      operations.push('browser:open')
    })
  }
  const http: AuthHttp = {
    createLoginRequest: vi.fn(async () => {
      operations.push('http:create-login')
      return {
        requestId: REQUEST_ID,
        browserUrl: `${API_ORIGIN}/auth/login/authorize?ticket=${Buffer.alloc(32, 8).toString('base64url')}`,
        expiresAt: '2026-09-06T12:10:00.000Z'
      }
    }),
    exchange: vi.fn(async () => {
      operations.push('http:exchange')
      return {
        ...tokenResponse(),
        user: { id: USER_ID, nickname: '모험가000001' },
        isNewUser: true
      }
    }),
    refresh: vi.fn(async () => {
      operations.push('http:refresh')
      return tokenResponse()
    }),
    logout: vi.fn(async () => {
      operations.push('http:logout')
    }),
    me: vi.fn(async () => {
      operations.push('http:me')
      return { user: { id: USER_ID, nickname: '모험가000001' } }
    })
  }

  const dependencies: AuthCoordinatorDependencies = {
    providers: ['google', 'discord'],
    apiOrigin: API_ORIGIN,
    returnTarget: RETURN_TARGET,
    browser,
    clock,
    entropy,
    http,
    store
  }

  return {
    dependencies,
    browser,
    clock,
    entropy,
    operations,
    http: {
      value: http,
      createLoginRequest: vi.mocked(http.createLoginRequest),
      exchange: vi.mocked(http.exchange),
      refresh: vi.mocked(http.refresh),
      logout: vi.mocked(http.logout),
      me: vi.mocked(http.me)
    },
    store
  }
}

export async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
