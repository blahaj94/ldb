import { describe, expect, it, vi } from 'vitest'
import type { SearchUiObservation } from './search-observation'
import { inspectMixedReadiness, inspectSandboxBoundary, isReloginReady } from './search-smoke'

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

    expect(
      isReloginReady({
        blank,
        afterLogin: { streams: 1, workers: 1 },
        stopped: { streams: 1, workers: 1 },
        currentRequests: 1,
        expectedRequests: 1
      })
    ).toBe(false)
    expect(reads).toEqual(['captureId'])
  })
})
