import type { AuthSnapshot } from '../../../preload/common/types/auth'
import {
  SEARCH_ERRORS,
  type SearchApi,
  type SearchObservation,
  type SearchCommandResult,
  type SearchSlot,
  type SearchSnapshot
} from '../../../preload/common/types/search'
import { SearchConnection } from './connection'

type CaptureTicket = {
  active: boolean
  captureId: string | null
  revisions: number[]
  cleared: boolean[]
}
export type SearchView = {
  ready: boolean
  slots: readonly SearchSlot[]
  retryPending: readonly boolean[]
  connectionFailed: boolean
}
type SearchOptions = {
  api: SearchApi
  notify: (observation: SearchObservation) => Promise<SearchCommandResult>
  onChange: (view: SearchView) => void
  onInvalidated: () => void
  resynchronizeAuth: () => void
}

export function emptySearchSlots(): SearchSlot[] {
  return Array.from({ length: 4 }, (_, slot) => ({
    slot,
    observationRevision: 0,
    requestId: null,
    nickname: null,
    state: 'idle',
    rows: [],
    error: null
  }))
}

export class CaptureSearch {
  private readonly connection: SearchConnection
  private capture: CaptureTicket | null = null
  private snapshot: SearchSnapshot | null = null
  private pending = new Map<number, string>()
  private failed = false

  constructor(private readonly options: SearchOptions) {
    this.connection = new SearchConnection({
      api: options.api,
      onSnapshot: (snapshot) => this.accept(snapshot),
      onFailure: () => {
        this.failed = true
        this.publish()
      },
      onRunChanged: () => {
        this.invalidate()
        options.resynchronizeAuth()
      }
    })
  }

  connect(): void {
    this.connection.connect()
  }

  async begin({
    auth,
    signal
  }: {
    auth: AuthSnapshot
    signal: AbortSignal
  }): Promise<string | null> {
    if (!this.connection.ready) {
      return null
    }
    this.end()
    const ticket: CaptureTicket = {
      active: true,
      captureId: null,
      revisions: [0, 0, 0, 0],
      cleared: [true, true, true, true]
    }
    this.capture = ticket
    this.publish()
    const result = await this.connection.command({
      action: 'begin',
      authRunId: auth.runId,
      authRevision: auth.revision
    })
    const isBeginSuccessful = result?.ok === true
    const captureId = isBeginSuccessful ? result.snapshot.captureId : null
    const hasCaptureId = captureId != null
    const hasCurrentTicket = this.capture === ticket
    const isTicketActive = hasCurrentTicket && ticket.active
    const isCurrentTicket = hasCurrentTicket && isTicketActive
    const latest = this.snapshot
    const completed = result?.snapshot
    const hasLatestSnapshot = latest != null
    const hasCompletedSnapshot = completed != null
    const isSignalAborted = signal.aborted

    const cancelBegin = (): null => {
      if (isCurrentTicket) {
        ticket.active = false
        this.capture = null
        this.publish()
      }
      // begin 자체의 성공 응답만 이 Start의 소유 ID를 증명한다. read의 ID는 사용하지 않는다.
      if (hasCaptureId) {
        void this.connection.command({ action: 'end', captureId })
      }
      return null
    }

    if (hasLatestSnapshot) {
      const hasDifferentCapture = latest.captureId !== captureId
      if (hasCompletedSnapshot) {
        const hasChangedRun = latest.runId !== completed.runId
        const hasNewerSnapshot = latest.revision > completed.revision
        const hasNewerDifferentCapture = hasNewerSnapshot && hasDifferentCapture
        const isSuperseded = hasChangedRun || hasNewerDifferentCapture
        if (isSuperseded) {
          return cancelBegin()
        }
      }
    }

    if (isSignalAborted || !isCurrentTicket) {
      return cancelBegin()
    }

    if (!hasCaptureId) {
      this.capture = null
      ticket.active = false
      this.publish()
      return null
    }
    ticket.captureId = captureId
    this.publish()
    return captureId
  }

  end(): void {
    const ticket = this.capture
    this.capture = null
    this.pending.clear()
    const hasTicket = ticket != null
    if (hasTicket) {
      ticket.active = false
      const captureId = ticket.captureId
      const hasId = captureId != null
      if (hasId) {
        void this.connection.command({ action: 'end', captureId })
      }
    }
    this.publish()
  }

  observe({ slot, nickname }: { slot: number; nickname: string | null }): void {
    const ticket = this.capture
    const captureId = ticket?.captureId
    const hasTicket = ticket != null
    const isTicketActive = hasTicket && ticket.active
    const hasCaptureId = captureId != null
    const canObserve = hasTicket && isTicketActive && hasCaptureId
    if (!canObserve) {
      return
    }
    ticket.revisions[slot] += 1
    const isClear = nickname === null
    ticket.cleared[slot] = isClear
    this.pending.delete(slot)
    const observationRevision = ticket.revisions[slot]
    this.publish()
    if (isClear) {
      void this.connection.command({ action: 'clear', captureId, slot, observationRevision })
    } else {
      void this.connection.invoke(() =>
        this.options.notify({ captureId, slot, observationRevision, nickname })
      )
    }
  }

  async retry(slotIndex: number): Promise<void> {
    const captureId = this.capture?.captureId
    const slot = this.visibleSlots()[slotIndex]
    const error = slot.error
    const isFailureState = slot.state === 'failure'
    const hasError = error != null
    const hasFailure = isFailureState && hasError
    const hasCaptureId = captureId != null
    const hasRequestId = slot.requestId != null
    const hasId = hasCaptureId && hasRequestId
    const isPending = this.pending.has(slotIndex)
    const canConsiderRetry = hasFailure && hasId && !isPending
    if (!canConsiderRetry) {
      return
    }
    const isRetryable = SEARCH_ERRORS[error.code].retryable
    const isRateLimit = error.code === 'SEARCH_RATE_LIMITED'
    const hasRetryAfter = isRateLimit && error.retryAfterSeconds != null
    const hasPositiveRetryAfter = hasRetryAfter && error.retryAfterSeconds > 0
    const isWaiting = isRateLimit && hasRetryAfter && hasPositiveRetryAfter
    const canRetry = isRetryable && !isWaiting
    if (!canRetry) {
      return
    }
    const requestId = slot.requestId
    this.pending.set(slotIndex, requestId)
    this.publish()
    await this.connection.command({ action: 'retry', captureId, slot: slotIndex, requestId })
    const isSameRequest = this.pending.get(slotIndex) === requestId
    if (isSameRequest) {
      this.pending.delete(slotIndex)
      this.publish()
    }
  }

  dispose(): void {
    this.end()
    this.connection.dispose()
  }

  private accept(snapshot: SearchSnapshot | null): void {
    this.snapshot = snapshot
    const hasSnapshot = snapshot != null
    if (hasSnapshot) {
      this.failed = false
    }
    const hasActiveId = this.capture?.captureId != null
    const hasEnded = hasSnapshot && snapshot.captureId === null
    const isInvalidated = hasActiveId && hasEnded
    if (isInvalidated) {
      this.invalidate()
    }
    this.publish()
  }

  private invalidate(): void {
    const ticket = this.capture
    this.capture = null
    this.pending.clear()
    const hasTicket = ticket != null
    if (hasTicket) {
      ticket.active = false
    }
    this.options.onInvalidated()
    this.publish()
  }

  private visibleSlots(): readonly SearchSlot[] {
    const ticket = this.capture
    const snapshot = this.snapshot
    const hasTicket = ticket != null
    const isTicketActive = hasTicket && ticket.active
    const hasCaptureId = isTicketActive && ticket.captureId != null
    const hasActiveTicket = isTicketActive && hasCaptureId
    const hasSnapshot = snapshot != null
    const canCompareCapture = hasActiveTicket && hasSnapshot
    const hasSameCapture = canCompareCapture && ticket.captureId === snapshot.captureId
    if (!hasSameCapture) {
      return emptySearchSlots()
    }
    const empty = emptySearchSlots()
    return snapshot.slots.map((slot) => {
      const observedRevision = ticket.revisions[slot.slot]
      const hasObserved = observedRevision > 0
      const isCurrent = slot.observationRevision >= observedRevision
      const isIdle = slot.state === 'idle'
      const isCleared = ticket.cleared[slot.slot]
      const canShow = isCurrent && (isIdle || (hasObserved && !isCleared))
      return canShow ? slot : empty[slot.slot]
    })
  }

  private publish(): void {
    this.options.onChange({
      ready: this.connection.ready,
      slots: this.visibleSlots(),
      retryPending: Array.from({ length: 4 }, (_, slot) => {
        const isPending = this.pending.has(slot)
        return isPending
      }),
      connectionFailed: this.failed
    })
  }
}
