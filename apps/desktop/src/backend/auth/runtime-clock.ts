import type { AuthClock, ClockReading } from './types'

// Client tolerance, including sampling uncertainty; not an OS accuracy guarantee.
const CLOCK_OFFSET_BUDGET_MS = 1_000

export type ClockPowerState = { suspended: boolean; revision: number }
type ClockSample = Readonly<{
  wallMs: number
  monotonicBeforeMs: number
  monotonicMs: number
}>
type RuntimeClockOptions = Readonly<{
  readWallMs(): number
  readMonotonicMs(): number
  powerState: ClockPowerState
}>

export function createRuntimeClock(options: RuntimeClockOptions): AuthClock {
  function sample(): ClockSample | null {
    try {
      const monotonicBeforeMs = options.readMonotonicMs()
      const wallMs = options.readWallMs()
      const monotonicMs = options.readMonotonicMs()
      const isWallFinite = Number.isFinite(wallMs)
      const isBeforeFinite = Number.isFinite(monotonicBeforeMs)
      const isAfterFinite = Number.isFinite(monotonicMs)
      const hasFiniteTimes = isWallFinite && isBeforeFinite && isAfterFinite
      const widthMs = monotonicMs - monotonicBeforeMs
      const isOrdered = widthMs >= 0
      const isBounded = widthMs <= CLOCK_OFFSET_BUDGET_MS
      const isUsable = hasFiniteTimes && isOrdered && isBounded
      if (!isUsable) {
        return null
      }
      return { wallMs, monotonicBeforeMs, monotonicMs }
    } catch {
      return null
    }
  }

  let baseline = sample()
  let previous = baseline
  let powerRevision = options.powerState.revision
  let discontinuous = baseline == null || options.powerState.suspended

  function read(): ClockReading {
    const current = sample()
    const baselineSample = baseline
    const previousSample = previous
    const hasPowerEvent = powerRevision !== options.powerState.revision
    const cannotCompare = current == null || baselineSample == null || previousSample == null
    if (cannotCompare) {
      discontinuous = true
    } else {
      const movedWallBack = current.wallMs < previousSample.wallMs
      const movedMonotonicBack = current.monotonicBeforeMs < previousSample.monotonicMs
      // The wall read lies somewhere inside each monotonic bracket. Both extremes
      // must fit the same budget; sample widths never enlarge that budget.
      const minimumOffsetChange =
        current.wallMs -
        current.monotonicMs -
        (baselineSample.wallMs - baselineSample.monotonicBeforeMs)
      const maximumOffsetChange =
        current.wallMs -
        current.monotonicBeforeMs -
        (baselineSample.wallMs - baselineSample.monotonicMs)
      const isBehindBudget = minimumOffsetChange < -CLOCK_OFFSET_BUDGET_MS
      const isAheadOfBudget = maximumOffsetChange > CLOCK_OFFSET_BUDGET_MS
      discontinuous ||= movedWallBack || movedMonotonicBack || isBehindBudget || isAheadOfBudget
    }
    discontinuous ||= hasPowerEvent || options.powerState.suspended
    previous = current ?? previous

    return {
      wallMs: current?.wallMs ?? previous?.wallMs ?? 0,
      monotonicMs: current?.monotonicMs ?? previous?.monotonicMs ?? 0,
      discontinuous
    }
  }

  return {
    read,
    startTrustPeriod: () => {
      baseline = sample()
      previous = baseline
      powerRevision = options.powerState.revision
      discontinuous = baseline == null || options.powerState.suspended
    },
    schedule: (delayMs, callback) => {
      const timeout = setTimeout(callback, delayMs)
      return () => clearTimeout(timeout)
    }
  }
}
