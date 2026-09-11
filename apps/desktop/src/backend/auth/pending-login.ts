import { createHash } from 'node:crypto'
import type {
  AuthClock,
  AuthHttp,
  AuthProvider,
  AuthSnapshot,
  ClockReading,
  LoginRequestResponse
} from './types'

const LOGIN_REQUEST_MAX_AGE_MS = 600_000

type PendingLoginInput = Readonly<{
  attemptId: string
  provider: AuthProvider
  verifier: string
  generation: number
  startedAt: ClockReading
}>

export type ClaimedExchange = Readonly<{
  status: 'claimed'
  input: Parameters<AuthHttp['exchange']>[0]
  signal: AbortSignal
}>

type ExchangeClaim =
  | Readonly<{ status: 'ignored' }>
  | Readonly<{ status: 'joined'; promise: Promise<void> }>
  | ClaimedExchange

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('base64url')
}

export class PendingLogin {
  readonly attemptId: string
  readonly provider: AuthProvider
  readonly generation: number
  private readonly verifier: string
  private readonly startedAt: ClockReading
  private lastAcceptedAt: ClockReading
  private requestId: string | null = null
  private expiresAt: string | null = null
  private expiresAtMs: number | null = null
  private stage: 'starting' | 'waiting' | 'exchanging' = 'starting'
  private rejectedFingerprint: string | null = null
  private exchangeFingerprint: string | null = null
  private exchangePromise: Promise<void> | null = null
  private controller = new AbortController()
  private cancelExpiry: (() => void) | null = null
  private disposed = false

  constructor(
    input: PendingLoginInput,
    private readonly clock: AuthClock,
    private readonly onExpired: (attempt: PendingLogin) => void
  ) {
    this.attemptId = input.attemptId
    this.provider = input.provider
    this.generation = input.generation
    this.verifier = input.verifier
    this.startedAt = input.startedAt
    this.lastAcceptedAt = input.startedAt
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get isBeforeExchange(): boolean {
    const isStarting = this.stage === 'starting'
    const isWaiting = this.stage === 'waiting'
    const isBeforeExchange = isStarting || isWaiting
    return isBeforeExchange
  }

  snapshot(): NonNullable<AuthSnapshot['login']> {
    return {
      attemptId: this.attemptId,
      provider: this.provider,
      expiresAt: this.expiresAt
    }
  }

  acceptRequest(response: LoginRequestResponse): void {
    this.requestId = response.requestId
    this.expiresAt = response.expiresAt
    this.expiresAtMs = Date.parse(response.expiresAt)
    this.stage = 'waiting'
  }

  isExpired(checkedAt: ClockReading): boolean {
    const isWallClockReversed = checkedAt.wallMs < this.lastAcceptedAt.wallMs
    const isMonotonicReversed = checkedAt.monotonicMs < this.lastAcceptedAt.monotonicMs
    const hasReachedMonotonicLimit =
      checkedAt.monotonicMs - this.startedAt.monotonicMs >= LOGIN_REQUEST_MAX_AGE_MS
    const expiresAtMs = this.expiresAtMs
    const hasServerExpiry = expiresAtMs != null
    let isExpired: boolean
    if (hasServerExpiry) {
      const hasReachedServerExpiry = checkedAt.wallMs >= expiresAtMs
      const hasExpiredClock =
        this.startedAt.discontinuous ||
        checkedAt.discontinuous ||
        isWallClockReversed ||
        isMonotonicReversed ||
        hasReachedMonotonicLimit
      isExpired = hasExpiredClock || hasReachedServerExpiry
    } else {
      isExpired =
        this.startedAt.discontinuous ||
        checkedAt.discontinuous ||
        isWallClockReversed ||
        isMonotonicReversed ||
        hasReachedMonotonicLimit
    }

    if (!isExpired) {
      this.lastAcceptedAt = checkedAt
    }
    return isExpired
  }

  scheduleExpiry(): void {
    this.cancelExpiry?.()
    if (this.disposed) {
      return
    }
    const checkedAt = this.clock.read()
    const isExpiredAtCheckTime = this.isExpired(checkedAt)
    if (isExpiredAtCheckTime) {
      this.onExpired(this)
      return
    }

    const monotonicRemaining =
      this.startedAt.monotonicMs + LOGIN_REQUEST_MAX_AGE_MS - checkedAt.monotonicMs
    const expiresAtMs = this.expiresAtMs
    const hasServerExpiry = expiresAtMs != null
    const wallRemaining = hasServerExpiry ? expiresAtMs - checkedAt.wallMs : monotonicRemaining
    const delayMs = Math.max(0, Math.min(monotonicRemaining, wallRemaining))
    const cancel = this.clock.schedule(delayMs, () => {
      if (this.disposed) {
        return
      }
      const firedAt = this.clock.read()
      const isExpiredAtCheckTime = this.isExpired(firedAt)
      if (isExpiredAtCheckTime) {
        this.onExpired(this)
      } else {
        this.scheduleExpiry()
      }
    })
    if (this.disposed) {
      cancel()
    } else {
      this.cancelExpiry = cancel
    }
  }

  claim(code: string): ExchangeClaim {
    const codeFingerprint = fingerprint(code)
    const wasRejected = this.rejectedFingerprint === codeFingerprint
    const shouldIgnore = this.disposed || wasRejected
    if (shouldIgnore) {
      return { status: 'ignored' }
    }
    const isExchangeInFlight = this.stage === 'exchanging'
    if (isExchangeInFlight) {
      const isSameExchange = this.exchangeFingerprint === codeFingerprint
      const exchangePromise = this.exchangePromise
      const hasExchangePromise = exchangePromise != null
      const canJoin = isSameExchange && hasExchangePromise
      return canJoin ? { status: 'joined', promise: exchangePromise } : { status: 'ignored' }
    }
    const requestId = this.requestId
    const isWaiting = this.stage === 'waiting'
    const hasRequestId = requestId != null
    const canExchange = isWaiting && hasRequestId
    if (!canExchange) {
      return { status: 'ignored' }
    }

    this.stage = 'exchanging'
    this.exchangeFingerprint = codeFingerprint
    this.controller = new AbortController()
    return {
      status: 'claimed',
      input: { requestId, clientId: 'desktop', code, codeVerifier: this.verifier },
      signal: this.controller.signal
    }
  }

  trackExchange(promise: Promise<void>): void {
    this.exchangePromise = promise
  }

  rejectCode(code: string): void {
    this.rejectedFingerprint = fingerprint(code)
  }

  resumeWaiting(): void {
    this.stage = 'waiting'
    this.exchangeFingerprint = null
  }

  dispose(): void {
    this.disposed = true
    this.cancelExpiry?.()
    this.cancelExpiry = null
    this.controller.abort()
  }
}
