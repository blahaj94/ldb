import { neopleSearchFailure } from '../errors/neople-search.js'
import type { SearchClock } from './types.js'

/** Admission 대기와 DB 처리에 하나의 monotonic 2초 deadline을 사용한다. */
export class SearchDeadline {
  private readonly controller = new AbortController()
  private readonly expiresAt: number
  private readonly timer: unknown
  private readonly failure: Promise<never>
  private reject!: (error: Error) => void

  constructor(private readonly clock: SearchClock, private readonly requestSignal?: AbortSignal) {
    this.expiresAt = clock.now() + 2000
    this.failure = new Promise<never>((_resolve, reject) => { this.reject = reject })
    // 이미 끊어진 HTTP 요청도 기다리는 Promise를 만들기 전에 abort할 수 있다.
    void this.failure.catch(() => undefined)
    this.timer = clock.setTimer(this.abort, 2000)
    requestSignal?.addEventListener('abort', this.abort, { once: true })
    const isAlreadyAborted = requestSignal?.aborted === true
    if (isAlreadyAborted) this.abort()
  }

  get signal(): AbortSignal { return this.controller.signal }

  readonly abort = (): void => {
    this.controller.abort()
    this.reject(neopleSearchFailure('internal'))
  }

  check(): void {
    const isExpired = this.clock.now() >= this.expiresAt
    const cannotContinue = isExpired || this.signal.aborted
    if (!cannotContinue) return
    this.abort()
    throw neopleSearchFailure('internal')
  }

  async wait<T>(operation: Promise<T>): Promise<T> {
    const result = await Promise.race([operation, this.failure])
    this.check()
    return result
  }

  dispose(): void {
    this.clock.clearTimer(this.timer)
    this.requestSignal?.removeEventListener('abort', this.abort)
  }
}
