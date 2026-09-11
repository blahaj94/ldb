import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from './auth-test-fixtures'

describe('인증 테스트 시계', () => {
  it('취소된 task의 deadline은 읽지 않고 활성 task의 deadline만 평가한다', () => {
    const clock = new FakeClock()
    const cancelledCallback = vi.fn()
    const cancel = clock.schedule(1, cancelledCallback)
    const activeCallback = vi.fn()
    clock.schedule(1, activeCallback)

    const cancelledTask = clock.scheduled[0]
    const activeTask = clock.scheduled[1]
    const cancelledDeadline = vi.fn(() => {
      throw new Error('cancelled task deadline was evaluated')
    })
    const activeDeadline = vi.fn(() => clock.monotonicMs)
    Object.defineProperty(cancelledTask, 'at', { configurable: true, get: cancelledDeadline })
    Object.defineProperty(activeTask, 'at', { configurable: true, get: activeDeadline })

    cancel()
    clock.advance(1)

    expect(cancelledDeadline).not.toHaveBeenCalled()
    expect(activeDeadline).toHaveBeenCalledTimes(1)
    expect(cancelledCallback).not.toHaveBeenCalled()
    expect(activeCallback).toHaveBeenCalledTimes(1)
  })

  it('due task snapshot을 예약 순서대로 실행하고 callback 중 예약된 task는 다음 advance에서 실행한다', () => {
    const clock = new FakeClock()
    const events: string[] = []

    clock.schedule(1, () => {
      events.push('first')
      clock.schedule(0, () => events.push('nested'))
    })
    clock.schedule(1, () => events.push('second'))

    clock.advance(1)
    expect(events).toEqual(['first', 'second'])

    clock.advance(0)
    expect(events).toEqual(['first', 'second', 'nested'])
  })
})
