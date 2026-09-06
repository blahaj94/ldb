import { vi } from 'vitest'
import type {
  AuthClock,
  AuthCoordinatorDependencies,
  AuthEntropy,
  AuthHttp,
  AuthTokens,
  CredentialInspection,
  CredentialStore,
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

export function tokenResponse(
  refreshToken = REFRESH_1,
  accessToken = ACCESS_1,
  accessTokenExpiresAt = '2026-09-06T12:15:00.000Z'
): AuthTokens {
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

  read() {
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

    const dueTasks = this.scheduled.filter((task) => !task.cancelled && task.at <= this.monotonicMs)
    for (const task of dueTasks) {
      task.cancelled = true
      task.callback()
    }
  }
}

export class FakeStore implements CredentialStore {
  inspection: CredentialInspection = { status: 'empty' }
  readonly establishOutcomes: StoreMutationOutcome[] = []
  readonly commitOutcomes: StoreMutationOutcome[] = []
  readonly clearOutcomes: StoreMutationOutcome[] = []
  readonly removeOutcomes: StoreMutationOutcome[] = []
  readonly reestablishOutcomes: StoreMutationOutcome[] = []

  readonly inspect = vi.fn(async () => this.inspection)
  readonly establishTransition = vi.fn(async () => this.next(this.establishOutcomes))
  readonly commitCredential = vi.fn(async () => this.next(this.commitOutcomes))
  readonly clearCredential = vi.fn(async () => this.next(this.clearOutcomes))
  readonly removeTransition = vi.fn(async () => this.next(this.removeOutcomes))
  readonly reestablishTransition = vi.fn(async () => this.next(this.reestablishOutcomes))

  private next(outcomes: StoreMutationOutcome[]): StoreMutationOutcome {
    return outcomes.shift() ?? 'confirmed'
  }
}

export type AuthHarness = ReturnType<typeof createAuthHarness>

export function createAuthHarness() {
  const clock = new FakeClock()
  const store = new FakeStore()
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
    open: vi.fn(async () => undefined)
  }
  const http: AuthHttp = {
    createLoginRequest: vi.fn(async () => ({
      requestId: REQUEST_ID,
      browserUrl: `${API_ORIGIN}/auth/login/authorize?ticket=${Buffer.alloc(32, 8).toString('base64url')}`,
      expiresAt: '2026-09-06T12:10:00.000Z'
    })),
    exchange: vi.fn(async () => ({
      ...tokenResponse(),
      user: { id: USER_ID, nickname: '모험가000001' },
      isNewUser: true
    })),
    refresh: vi.fn(async () => tokenResponse()),
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => ({ user: { id: USER_ID, nickname: '모험가000001' } }))
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
