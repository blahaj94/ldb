import { describe, expect, it, vi } from 'vitest'
import type { SearchUiObservation } from './search-observation'
import {
  inspectMixedReadiness,
  inspectSandboxBoundary,
  isReloginReady,
  sameRequest
} from './search-smoke'

describe('search smoke protected evaluation', () => {
  it('Electron 노출 시 require getter를 읽지 않는다', () => {
    const reads: string[] = []
    const window = Object.defineProperties(
      {},
      {
        electron: { get: () => (reads.push('electron'), {}) },
        require: {
          get: () => {
            throw new Error('require getter must stay skipped')
          }
        }
      }
    )

    expect(inspectSandboxBoundary(window)).toBe(false)
    expect(reads).toEqual(['electron'])
  })

  it('sandbox 검사는 electron 다음 require를 각각 한 번 읽는다', () => {
    const reads: string[] = []
    const window = Object.defineProperties(
      {},
      {
        electron: { get: () => (reads.push('electron'), undefined) },
        require: { get: () => (reads.push('require'), undefined) }
      }
    )

    expect(inspectSandboxBoundary(window)).toBe(true)
    expect(reads).toEqual(['electron', 'require'])
  })

  it('sameRequest는 requestId 부재 뒤 observationRevision 비교를 유지한다', () => {
    const reads: string[] = []
    const before = Object.defineProperties(
      {},
      {
        requestId: { get: () => (reads.push('requestId'), null) },
        observationRevision: { get: () => (reads.push('observationRevision'), 1) }
      }
    ) as SearchUiObservation['slots'][number]
    const after = { requestId: null, observationRevision: 1 } as SearchUiObservation['slots'][number]

    expect(sameRequest({ before, after })).toBe(false)
    expect(reads).toEqual(['requestId', 'observationRevision'])
  })

  it('region이 불완전해도 count를 먼저 읽고 every는 건너뛴다', () => {
    const calls: string[] = []
    const slots = {
      filter: vi.fn(() => (calls.push('filter'), [])),
      every: vi.fn(() => {
        throw new Error('every must stay skipped')
      })
    }
    const view = Object.defineProperties(
      {},
      {
        slots: { get: () => (calls.push('slots'), slots) },
        regionMask: { get: () => (calls.push('regionMask'), 7) }
      }
    ) as SearchUiObservation

    expect(inspectMixedReadiness(view)).toEqual({
      ready: false,
      regionMask: 7,
      statusesMatched: false,
      failureCount: 0,
      pendingCount: 0,
      limitedCount: 0
    })
    expect(calls).toEqual(['slots', 'filter', 'slots', 'filter', 'slots', 'filter', 'regionMask'])
    expect(slots.every).not.toHaveBeenCalled()
  })

  it('relogin guard는 실패 뒤 getter와 hasState 경계를 읽지 않는다', () => {
    const reads: string[] = []
    const blank = Object.defineProperties(
      {},
      {
        captureId: { get: () => (reads.push('captureId'), 'active') },
        sourceSelected: {
          get: () => {
            throw new Error('sourceSelected must stay skipped')
          }
        },
        startDisabled: {
          get: () => {
            throw new Error('startDisabled must stay skipped')
          }
        },
        slots: {
          get: () => {
            throw new Error('hasState must stay skipped')
          }
        }
      }
    ) as SearchUiObservation
    const readCurrentRequests = vi.fn(() => {
      throw new Error('request count must stay skipped')
    })

    expect(
      isReloginReady({
        blank,
        afterLogin: { streams: 1, workers: 1 },
        stopped: { streams: 1, workers: 1 },
        readCurrentRequests,
        expectedRequests: 1
      })
    ).toBe(false)
    expect(reads).toEqual(['captureId'])
    expect(readCurrentRequests).not.toHaveBeenCalled()
  })

  it('relogin guard가 모두 통과하면 request count를 마지막에 한 번 읽는다', () => {
    const reads: string[] = []
    const slots = Array.from({ length: 4 }, () => ({
      state: 'idle',
      statusMatched: true
    }))
    const blank = Object.defineProperties(
      {},
      {
        captureId: { get: () => (reads.push('captureId'), null) },
        sourceSelected: { get: () => (reads.push('sourceSelected'), false) },
        startDisabled: { get: () => (reads.push('startDisabled'), true) },
        regionMask: { get: () => (reads.push('regionMask'), 15) },
        slots: { get: () => (reads.push('slots'), slots) }
      }
    ) as SearchUiObservation
    const readCurrentRequests = vi.fn(() => (reads.push('requests'), 3))

    expect(
      isReloginReady({
        blank,
        afterLogin: { streams: 2, workers: 4 },
        stopped: { streams: 2, workers: 4 },
        readCurrentRequests,
        expectedRequests: 3
      })
    ).toBe(true)
    expect(reads).toEqual([
      'captureId',
      'sourceSelected',
      'startDisabled',
      'regionMask',
      'slots',
      'requests'
    ])
    expect(readCurrentRequests).toHaveBeenCalledOnce()
  })
})
