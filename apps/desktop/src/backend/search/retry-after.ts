import type { AuthClock } from '../auth/types'

export type RetryAfter = { clock: AuthClock; receivedAt: number; seconds: number }

export function remainingRetryAfter({ clock, receivedAt, seconds }: RetryAfter): number {
  const elapsed = clock.read().monotonicMs - receivedAt
  return Math.max(0, seconds * 1_000 - elapsed)
}

export function waitForRetryAfter(input: RetryAfter & { onReady: () => void }): () => void {
  let stopped = false
  let cancelTimer = (): void => undefined

  function check(): void {
    if (stopped) {
      return
    }
    const remaining = remainingRetryAfter(input)
    const isReady = remaining === 0
    if (isReady) {
      stopped = true
      input.onReady()
      return
    }
    // 큰 유효 초를 Node timer overflow로 즉시 만료시키지 않는다.
    cancelTimer = input.clock.schedule(Math.min(remaining, 2_147_483_647), check)
  }

  check()
  return () => {
    stopped = true
    cancelTimer()
  }
}
