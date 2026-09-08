import { randomUUID } from 'node:crypto'
import type { AuthCoordinator } from '../auth/types'
import { SearchHttpFailure, type SearchHttp } from './http'
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
}

type Options = {
  publish: (snapshot: SearchSnapshot) => void
  isCurrent: (binding: CaptureBinding) => boolean
  runtime?: { auth: AuthCoordinator; http: SearchHttp }
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

    this.cancelSlot(input.slot)
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
    const request = { ...input, requestId, controller: new AbortController() }
    if (isValidInput) {
      this.requests[input.slot] = request
    }
    this.emit()
    if (isValidInput) {
      void this.execute(request, runtime)
    }
    return this.result()
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
    const isCurrentCapture = this.binding?.captureId === input.captureId
    const isCurrentRequest = this.slots[input.slot].requestId === input.requestId
    const isCurrent = isCurrentCapture && isCurrentRequest
    return this.result(isCurrent ? 'SEARCH_RETRY_NOT_READY' : 'STALE_SEARCH')
  }

  private cancelSlot(slot: number): void {
    const request = this.requests[slot]
    this.requests[slot] = null
    request?.controller.abort()
  }

  private canComplete(request: SearchRequest): boolean {
    const binding = this.binding
    const hasBinding = binding != null
    const hasPermission = hasBinding && this.options.isCurrent(binding)
    const hasSameCapture = hasBinding && binding.captureId === request.captureId
    const hasSameRequest = this.requests[request.slot] === request
    const hasSameObservation =
      this.slots[request.slot].observationRevision === request.observationRevision
    const canComplete = hasPermission && hasSameCapture && hasSameRequest && hasSameObservation
    return canComplete
  }

  private async execute(
    request: SearchRequest,
    runtime: NonNullable<Options['runtime']>
  ): Promise<void> {
    if (!this.canComplete(request)) {
      return
    }
    try {
      const authorization = await runtime.auth.authorization(request.controller.signal)
      const isCurrentRequest = this.canComplete(request)
      const hasAuthorization = authorization.status === 'available'
      const hasSameAuth =
        hasAuthorization && authorization.generation === this.binding?.authGeneration
      const canSend = isCurrentRequest && hasAuthorization && hasSameAuth
      if (!canSend) {
        return
      }
      const rows = await runtime.http({
        nickname: request.nickname,
        accessToken: authorization.accessToken,
        signal: request.controller.signal
      })
      if (!this.canComplete(request)) {
        return
      }
      const hasRows = rows.length > 0
      this.slots[request.slot] = {
        ...this.slots[request.slot],
        state: hasRows ? 'success' : 'empty',
        rows,
        error: null
      }
    } catch (error) {
      if (!this.canComplete(request)) {
        return
      }
      const isSearchFailure = error instanceof SearchHttpFailure
      const code = isSearchFailure ? error.code : 'SEARCH_NETWORK_ERROR'
      this.slots[request.slot] = {
        ...this.slots[request.slot],
        state: 'failure',
        rows: [],
        error: { code, retryAfterSeconds: null }
      }
    }
    this.requests[request.slot] = null
    this.emit()
  }

  private emit(): void {
    const binding = this.binding
    const hasBinding = binding != null
    const isInvalidated = hasBinding && !this.options.isCurrent(binding)
    if (isInvalidated) {
      this.invalidate()
      return
    }
    this.revision += 1
    this.options.publish(this.snapshot())
  }
}
