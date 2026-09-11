import { expect, it, vi } from 'vitest'
import { CaptureSearchLifetime, type CaptureBinding } from './capture-lifetime'
import type { SearchRuntime } from './request'
import type {
  SearchObservation,
  SearchSlot,
  SearchSnapshot
} from '../../preload/common/types/search'

type LifetimeInternals = {
  binding: CaptureBinding | null
  requests: Array<{ controller: AbortController } | null>
  slots: SearchSlot[]
  startRequest: (input: {
    input: SearchObservation
    runtime: SearchRuntime
    finalRejection: boolean
  }) => { ok: boolean }
  isCurrentSlot: (request: { slot: number; captureId: string; requestId: string }) => boolean
}

function internals(lifetime: CaptureSearchLifetime): LifetimeInternals {
  return lifetime as unknown as LifetimeInternals
}

function runtime(clock: SearchRuntime['clock']): SearchRuntime {
  return {
    auth: {} as SearchRuntime['auth'],
    http: vi.fn(async () => []),
    clock
  }
}

function binding(): Omit<CaptureBinding, 'captureId'> {
  return { authGeneration: 1, windowGeneration: 2, sourceGeneration: 3 }
}

it('startRequest는 clock read, cancelSlot, binding 검사의 순서를 유지한다', () => {
  const events: string[] = []
  const clock = {
    read: vi.fn(() => {
      events.push('clock.read')
      return { wallMs: 0, monotonicMs: 1_000, discontinuous: false }
    }),
    schedule: vi.fn(() => () => undefined)
  }
  const isCurrent = vi.fn(() => {
    events.push('isCurrent')
    return true
  })
  const lifetime = new CaptureSearchLifetime({
    publish: vi.fn<(snapshot: SearchSnapshot) => void>(),
    isCurrent,
    runtime: runtime(clock)
  })
  const begun = lifetime.begin(binding())
  const captureId = begun.snapshot.captureId
  expect(captureId).toEqual(expect.any(String))

  const requestController = new AbortController()
  requestController.signal.addEventListener('abort', () => events.push('cancelSlot'))
  internals(lifetime).requests[0] = { controller: requestController }
  events.length = 0

  const result = internals(lifetime).startRequest({
    input: {
      captureId: captureId as string,
      slot: 0,
      observationRevision: 1,
      nickname: ''
    },
    runtime: runtime(clock),
    finalRejection: false
  })

  expect(result).toMatchObject({ ok: true })
  expect(events.slice(0, 3)).toEqual(['clock.read', 'cancelSlot', 'isCurrent'])
})

it('isCurrentSlot은 권한이 없어도 capture와 request ID 비교를 평가한다', () => {
  const events: string[] = []
  const isCurrentBinding = vi.fn(() => true)
  const lifetime = new CaptureSearchLifetime({
    publish: vi.fn(),
    isCurrent: isCurrentBinding
  })
  lifetime.begin(binding())
  isCurrentBinding.mockImplementation(() => {
    events.push('permission')
    return false
  })
  const state = internals(lifetime)
  const currentBinding = state.binding
  expect(currentBinding).not.toBeNull()
  state.binding = new Proxy(currentBinding as CaptureBinding, {
    get(target, property, receiver) {
      if (property === 'captureId') {
        events.push('capture')
      }
      return Reflect.get(target, property, receiver)
    }
  })
  const currentSlot = state.slots[0]
  state.slots[0] = new Proxy(currentSlot, {
    get(target, property, receiver) {
      if (property === 'requestId') {
        events.push('requestId')
      }
      return Reflect.get(target, property, receiver)
    }
  })
  events.length = 0

  const isCurrentSlot = state.isCurrentSlot({
    slot: 0,
    captureId: 'capture-1',
    requestId: 'request-1'
  })

  expect(isCurrentSlot).toBe(false)
  expect(events).toEqual(['permission', 'capture', 'requestId'])
})

it('binding이 없을 때도 emit은 revision 증가와 publish를 유지한다', () => {
  const publish = vi.fn<(snapshot: SearchSnapshot) => void>()
  const lifetime = new CaptureSearchLifetime({
    publish,
    isCurrent: vi.fn(() => true)
  })
  const begun = lifetime.begin(binding())
  const captureId = begun.snapshot.captureId as string
  const before = lifetime.snapshot()
  publish.mockClear()

  const ended = lifetime.end(captureId)

  expect(ended.snapshot.captureId).toBeNull()
  expect(ended.snapshot.revision).toBe(before.revision + 1)
  expect(publish).toHaveBeenCalledTimes(1)
  expect(publish).toHaveBeenLastCalledWith(ended.snapshot)
})
