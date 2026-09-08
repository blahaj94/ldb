import type {
  SearchApi,
  SearchCommandResult,
  SearchControl,
  SearchSnapshot
} from '../../../preload/common/types/search'
import { parseSearchResult, parseSearchSnapshot } from '../../../preload/common/search/snapshot'

type ConnectionOptions = {
  api: SearchApi
  onSnapshot: (snapshot: SearchSnapshot | null) => void
  onFailure: () => void
  onRunChanged: () => void
}

export class SearchConnection {
  private active = true
  private epoch = 0
  private current: SearchSnapshot | null = null
  private unsubscribe: () => void = () => {}

  constructor(private readonly options: ConnectionOptions) {}

  connect(): void {
    this.unsubscribe()
    this.epoch += 1
    const expected = this.epoch
    this.current = null
    this.options.onSnapshot(null)
    let ready = false
    let queued: SearchSnapshot | null = null
    try {
      this.unsubscribe = this.options.api.onCharacterSearchChanged((value) => {
        const isCurrent = this.isCurrent(expected)
        if (!isCurrent) {
          return
        }
        const snapshot = parseSearchSnapshot(value)
        const isValid = snapshot != null
        if (!isValid) {
          return
        }
        if (ready) {
          this.accept(snapshot, expected)
          return
        }
        const hasQueued = queued != null
        const hasSameRun = hasQueued && queued.runId === snapshot.runId
        const isOlder = hasSameRun && snapshot.revision <= queued.revision
        if (!isOlder) {
          queued = snapshot
        }
      })
      void this.read(expected).then(() => {
        const isCurrent = this.isCurrent(expected)
        if (!isCurrent) {
          return
        }
        ready = true
        const buffered = queued
        queued = null
        const hasBuffered = buffered != null
        if (hasBuffered) {
          this.accept(buffered, expected)
        }
      })
    } catch {
      this.options.onFailure()
    }
  }

  async command(control: SearchControl): Promise<SearchCommandResult | null> {
    return this.invoke(() => this.options.api.controlCharacterSearch(control))
  }

  async invoke(send: () => Promise<SearchCommandResult>): Promise<SearchCommandResult | null> {
    const expected = this.epoch
    try {
      const result = parseSearchResult(await send())
      const isValid = result != null
      if (!isValid) {
        throw new Error('Invalid search bridge response')
      }
      this.accept(result.snapshot, expected)
      return result
    } catch {
      const isCurrent = this.isCurrent(expected)
      if (isCurrent) {
        await this.read(expected)
      }
      // 응답이 유실된 mutation은 재전송하거나 성공한 명령으로 합성하지 않는다.
      return null
    }
  }

  dispose(): void {
    this.active = false
    this.epoch += 1
    this.unsubscribe()
  }

  private isCurrent(expected: number): boolean {
    const hasSameEpoch = expected === this.epoch
    const isCurrent = this.active && hasSameEpoch
    return isCurrent
  }

  private async read(expected: number): Promise<void> {
    try {
      const result = parseSearchResult(
        await this.options.api.controlCharacterSearch({ action: 'read' })
      )
      const isValid = result != null
      if (!isValid) {
        throw new Error('Invalid search bridge response')
      }
      this.accept(result.snapshot, expected)
    } catch {
      const isCurrent = this.isCurrent(expected)
      if (isCurrent) {
        this.current = null
        this.options.onSnapshot(null)
        this.options.onFailure()
      }
    }
  }

  private accept(snapshot: SearchSnapshot, expected: number): void {
    const isCurrent = this.isCurrent(expected)
    if (!isCurrent) {
      return
    }
    const previous = this.current
    const hasPrevious = previous != null
    const hasChangedRun = hasPrevious && previous.runId !== snapshot.runId
    if (hasChangedRun) {
      this.options.onRunChanged()
      this.connect()
      return
    }
    const isNewer = !hasPrevious || snapshot.revision > previous.revision
    if (!isNewer) {
      return
    }
    this.current = snapshot
    this.options.onSnapshot(snapshot)
  }
}
