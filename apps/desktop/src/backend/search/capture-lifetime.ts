import { randomUUID } from 'node:crypto'
import { runSearchRequest, type SearchOutcome, type SearchRuntime } from './request'
import { remainingRetryAfter, waitForRetryAfter, type RetryAfter } from './retry-after'
import { SEARCH_ERRORS } from '../../preload/common/types/search'
import type {
  SearchCommandError,
  SearchCommandResult,
  SearchControl,
  SearchObservation,
  SearchSlot,
  SearchSnapshot
} from '../../preload/common/types/search'

export type CaptureBinding = Readonly<{
  captureId: string
  authGeneration: number
  windowGeneration: number
  sourceGeneration: number
}>

type SearchRequest = {
  captureId: string
  slot: number
  requestId: string
  observationRevision: number
  nickname: string
  controller: AbortController
  authGeneration: number
  startedAt: number
  finalRejection: boolean
}
type RequestIdentity = Pick<SearchRequest, 'slot' | 'captureId' | 'requestId'>
type RateWait = RequestIdentity & RetryAfter & { cancel: () => void }

type Options = {
  publish: (snapshot: SearchSnapshot) => void
  isCurrent: (binding: CaptureBinding) => boolean
  runtime?: SearchRuntime
}

function idleSlot({
  slot,
  observationRevision = 0
}: {
  slot: number
  observationRevision?: number
}): SearchSlot {
  return {
    slot,
    observationRevision,
    requestId: null,
    nickname: null,
    state: 'idle',
    rows: [],
    error: null
  }
}

function validNickname(nickname: string): boolean {
  const length = [...nickname].length
  const hasAllowedLength = length >= 2 && length <= 12
  const hasNoOuterWhitespace = nickname === nickname.trim()
  const isWellFormed = nickname.isWellFormed()
  const isValid = hasAllowedLength && hasNoOuterWhitespace && isWellFormed
  return isValid
}

export class CaptureSearchLifetime {
  private readonly runId = randomUUID()
  private revision = 0
  private binding: CaptureBinding | null = null
  private slots = [0, 1, 2, 3].map((slot) => idleSlot({ slot }))
  private readonly requests: Array<SearchRequest | null> = [null, null, null, null]
  private readonly rateWaits: Array<RateWait | null> = [null, null, null, null]

  constructor(private readonly options: Options) {}

  get current(): CaptureBinding | null {
    return this.binding
  }

  snapshot(): SearchSnapshot {
    return {
      runId: this.runId,
      revision: this.revision,
      captureId: this.binding?.captureId ?? null,
      slots: this.slots.map((slot) => {
        const error = slot.error
        const hasError = error != null
        return {
          ...slot,
          rows: slot.rows.map((row) => ({ ...row })),
          error: hasError ? { ...error } : null
        }
      })
    }
  }

  result(code?: SearchCommandError): SearchCommandResult {
    const snapshot = this.snapshot()
    const hasError = code != null
    return hasError ? { ok: false, error: { code }, snapshot } : { ok: true, snapshot }
  }

  begin(binding: Omit<CaptureBinding, 'captureId'>): SearchCommandResult {
    this.binding = { ...binding, captureId: randomUUID() }
    this.emit()
    return this.result()
  }

  end(captureId: string): SearchCommandResult {
    const isCurrentCapture = this.binding?.captureId === captureId
    if (isCurrentCapture) {
      this.invalidate()
    }
    return this.result()
  }

  invalidate(): void {
    const hasCapture = this.binding != null
    if (!hasCapture) {
      return
    }
    this.binding = null
    for (const slot of [0, 1, 2, 3]) {
      this.cancelSlot(slot)
    }
    this.slots = [0, 1, 2, 3].map((slot) => idleSlot({ slot }))
    this.emit()
  }

  observe(input: SearchObservation): SearchCommandResult {
    const isCurrentCapture = this.binding?.captureId === input.captureId
    if (!isCurrentCapture) {
      return this.result('STALE_SEARCH')
    }
    const runtime = this.options.runtime
    const hasRuntime = runtime != null
    if (!hasRuntime) {
      return this.result('SEARCH_NOT_ALLOWED')
    }
    const previous = this.slots[input.slot]
    const isNewerObservation = input.observationRevision > previous.observationRevision
    if (!isNewerObservation) {
      return this.result()
    }
    const hasSameNickname = input.nickname === previous.nickname
    if (hasSameNickname) {
      this.slots[input.slot] = { ...previous, observationRevision: input.observationRevision }
      const pending = this.requests[input.slot]
      const hasPending = pending != null
      if (hasPending) {
        pending.observationRevision = input.observationRevision
      }
      this.emit()
      return this.result()
    }

    return this.startRequest({ input, runtime, finalRejection: false })
  }

  clear(input: Extract<SearchControl, { action: 'clear' }>): SearchCommandResult {
    const isCurrentCapture = this.binding?.captureId === input.captureId
    if (!isCurrentCapture) {
      return this.result('STALE_SEARCH')
    }
    const isNewer = input.observationRevision > this.slots[input.slot].observationRevision
    if (isNewer) {
      this.cancelSlot(input.slot)
      this.slots[input.slot] = idleSlot(input)
      this.emit()
    }
    return this.result()
  }

  retry(input: Extract<SearchControl, { action: 'retry' }>): SearchCommandResult {
    const slot = this.slots[input.slot]
    const isCurrent = this.isCurrentSlot(input)
    if (!isCurrent) {
      return this.result('STALE_SEARCH')
    }
    const error = slot.error
    const isFailure = slot.state === 'failure'
    const hasError = error != null
    if (!isFailure) {
      return this.result('SEARCH_RETRY_NOT_READY')
    }
    if (!hasError) {
      return this.result('SEARCH_RETRY_NOT_READY')
    }
    const isRetryable = SEARCH_ERRORS[error.code].retryable
    if (!isRetryable) {
      return this.result('SEARCH_RETRY_NOT_READY')
    }
    const wait = this.rateWaits[input.slot]
    const hasWait = wait != null
    let isWaiting = false
    if (hasWait) {
      const remaining = remainingRetryAfter(wait)
      isWaiting = remaining > 0
    }
    if (isWaiting) {
      return this.result('SEARCH_RETRY_NOT_READY')
    }
    const runtime = this.options.runtime
    const nickname = slot.nickname
    const hasRuntime = runtime != null
    const hasNickname = nickname != null
    const canStart = hasRuntime && hasNickname
    if (!canStart) {
      return this.result('SEARCH_NOT_ALLOWED')
    }
    const finalRejection = error.code === 'SEARCH_AUTH_RETRY_REQUIRED'
    return this.startRequest({
      input: {
        captureId: input.captureId,
        slot: input.slot,
        observationRevision: slot.observationRevision,
        nickname
      },
      runtime,
      finalRejection
    })
  }

  private startRequest({
    input,
    runtime,
    finalRejection
  }: {
    input: SearchObservation
    runtime: SearchRuntime
    finalRejection: boolean
  }): SearchCommandResult {
    const startedAt = runtime.clock.read().monotonicMs
    this.cancelSlot(input.slot)
    const binding = this.binding
    const hasBinding = binding != null
    if (!hasBinding) {
      return this.result('STALE_SEARCH')
    }
    const hasSameCapture = binding.captureId === input.captureId
    if (!hasSameCapture) {
      return this.result('STALE_SEARCH')
    }
    const hasPermission = this.options.isCurrent(binding)
    if (!hasPermission) {
      return this.result('STALE_SEARCH')
    }
    const requestId = randomUUID()
    const isValidInput = validNickname(input.nickname)
    this.slots[input.slot] = {
      slot: input.slot,
      observationRevision: input.observationRevision,
      requestId,
      nickname: input.nickname,
      state: isValidInput ? 'pending' : 'failure',
      rows: [],
      error: isValidInput ? null : { code: 'INVALID_SEARCH_QUERY', retryAfterSeconds: null }
    }
    const request = {
      ...input,
      requestId,
      controller: new AbortController(),
      authGeneration: binding.authGeneration,
      startedAt,
      finalRejection
    }
    if (isValidInput) {
      this.requests[input.slot] = request
    }
    this.emit()
    if (isValidInput) {
      void this.execute(request, runtime)
    }
    return this.result()
  }

  private cancelSlot(slot: number): void {
    const request = this.requests[slot]
    const wait = this.rateWaits[slot]
    this.requests[slot] = null
    this.rateWaits[slot] = null
    wait?.cancel()
    request?.controller.abort()
  }

  private isCurrentSlot(request: RequestIdentity): boolean {
    const binding = this.binding
    const hasBinding = binding != null
    let hasPermission = false
    if (hasBinding) {
      hasPermission = this.options.isCurrent(binding)
    }
    let hasSameCapture = false
    if (hasBinding) {
      hasSameCapture = binding.captureId === request.captureId
    }
    const hasSameRequestId = this.slots[request.slot].requestId === request.requestId
    const isCurrent = hasPermission && hasSameCapture && hasSameRequestId
    return isCurrent
  }

  private canComplete(request: SearchRequest): boolean {
    const isCurrentSlot = this.isCurrentSlot(request)
    const hasSameRequest = this.requests[request.slot] === request
    const hasSameObservation =
      this.slots[request.slot].observationRevision === request.observationRevision
    const canComplete = isCurrentSlot && hasSameRequest && hasSameObservation
    return canComplete
  }

  private async execute(request: SearchRequest, runtime: SearchRuntime): Promise<void> {
    let outcome: SearchOutcome
    try {
      outcome = await runSearchRequest({
        runtime,
        nickname: request.nickname,
        authGeneration: request.authGeneration,
        startedAt: request.startedAt,
        finalRejection: request.finalRejection,
        signal: request.controller.signal,
        isCurrent: () => this.canComplete(request)
      })
    } catch {
      outcome = {
        kind: 'failure',
        error: { code: 'SEARCH_NETWORK_ERROR', retryAfterSeconds: null },
        retryAfterReceivedAt: null
      }
    }
    const result = outcome
    const isCurrentRequest = this.canComplete(request)
    const hasOutcome = result != null
    const canPublish = isCurrentRequest && hasOutcome
    if (!canPublish) {
      return
    }
    const isSuccess = result.kind === 'success'
    if (isSuccess) {
      const hasRows = result.rows.length > 0
      this.slots[request.slot] = {
        ...this.slots[request.slot],
        state: hasRows ? 'success' : 'empty',
        rows: result.rows,
        error: null
      }
    } else {
      this.slots[request.slot] = {
        ...this.slots[request.slot],
        state: 'failure',
        rows: [],
        error: result.error
      }
    }
    this.requests[request.slot] = null
    this.emit()
    if (!isSuccess) {
      const seconds = result.error.retryAfterSeconds
      const receivedAt = result.retryAfterReceivedAt
      const isRateLimited = result.error.code === 'SEARCH_RATE_LIMITED'
      const hasRetryAfter = seconds != null
      const hasReceivedAt = receivedAt != null
      let retryAfter: { seconds: number; receivedAt: number } | null = null
      if (hasRetryAfter) {
        const hasPositiveRetryAfter = seconds > 0
        const hasWait = hasPositiveRetryAfter && hasReceivedAt
        if (hasWait) {
          retryAfter = { seconds, receivedAt }
        }
      }
      if (!isRateLimited) {
        return
      }
      if (retryAfter == null) {
        return
      }
      const isCurrentSlot = this.isCurrentSlot(request)
      if (!isCurrentSlot) {
        return
      }
      this.startRateWait(request, { clock: runtime.clock, ...retryAfter })
    }
  }

  private startRateWait(request: RequestIdentity, retryAfter: RetryAfter): void {
    const wait: RateWait = {
      slot: request.slot,
      captureId: request.captureId,
      requestId: request.requestId,
      ...retryAfter,
      cancel: () => undefined
    }
    this.rateWaits[request.slot] = wait
    wait.cancel = waitForRetryAfter({
      ...retryAfter,
      onReady: () => {
        const isCurrentWait = this.rateWaits[wait.slot] === wait
        const canPublish = isCurrentWait && this.isCurrentSlot(wait)
        if (!canPublish) {
          return
        }
        this.rateWaits[wait.slot] = null
        this.slots[wait.slot] = {
          ...this.slots[wait.slot],
          error: { code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: 0 }
        }
        this.emit()
      }
    })
  }

  private emit(): void {
    const binding = this.binding
    const hasBinding = binding != null
    if (hasBinding) {
      const hasPermission = this.options.isCurrent(binding)
      const isInvalidated = !hasPermission
      if (isInvalidated) {
        this.invalidate()
        return
      }
    }
    this.revision += 1
    this.options.publish(this.snapshot())
  }
}
