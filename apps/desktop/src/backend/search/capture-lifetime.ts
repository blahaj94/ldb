import { randomUUID } from 'node:crypto'
import type {
  SearchCommandError,
  SearchCommandResult,
  SearchSnapshot
} from '../../preload/common/types/search'

export type CaptureBinding = Readonly<{
  captureId: string
  authGeneration: number
  windowGeneration: number
  sourceGeneration: number
}>

export class CaptureSearchLifetime {
  private readonly runId = randomUUID()
  private revision = 0
  private binding: CaptureBinding | null = null

  constructor(private readonly publish: (snapshot: SearchSnapshot) => void) {}

  get current(): CaptureBinding | null {
    return this.binding
  }

  snapshot(): SearchSnapshot {
    return {
      runId: this.runId,
      revision: this.revision,
      captureId: this.binding?.captureId ?? null,
      slots: [0, 1, 2, 3].map((slot) => ({
        slot,
        observationRevision: 0,
        requestId: null,
        nickname: null,
        state: 'idle',
        rows: [],
        error: null
      }))
    }
  }

  result(code?: SearchCommandError): SearchCommandResult {
    const snapshot = this.snapshot()
    const hasError = code != null
    return hasError ? { ok: false, error: { code }, snapshot } : { ok: true, snapshot }
  }

  begin(binding: Omit<CaptureBinding, 'captureId'>): SearchCommandResult {
    this.binding = { ...binding, captureId: randomUUID() }
    this.revision += 1
    this.publish(this.snapshot())
    return this.result()
  }

  end(captureId: string): SearchCommandResult {
    const isCurrentCapture = this.binding?.captureId === captureId
    if (isCurrentCapture) this.invalidate()
    return this.result()
  }

  invalidate(): void {
    const hasCapture = this.binding != null
    if (!hasCapture) return
    this.binding = null
    this.revision += 1
    this.publish(this.snapshot())
  }
}
