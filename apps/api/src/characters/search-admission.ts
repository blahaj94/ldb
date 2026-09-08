import { neopleSearchFailure } from '../errors/neople-search.js'
import type { SearchClock } from './types.js'

const windowMs = 60_000
const capacity = 10

export const searchClock: SearchClock = {
  now: () => performance.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
}

interface Lease {
  assertCapacity(): void
  reserve(): void
  release(): void
}

interface Waiter {
  grant(): void
  cancel(): void
}

interface AccountEntry {
  reservations: number[]
  owner?: Waiter
  waiting: Set<Waiter>
  timer?: unknown
}

/** 최근 예약과 살아 있는 admission만 유지한다. Quota가 비기를 기다리는 queue는 없다. */
export class SearchAdmission {
  private readonly entries = new Map<string, AccountEntry>()
  private closed = false

  constructor(private readonly clock: SearchClock = searchClock) {}

  get entryCount(): number {
    return this.entries.size
  }

  acquire(account: string, signal: AbortSignal): Promise<Lease> {
    const cannotAcquire = signal.aborted || this.closed
    if (cannotAcquire) {
      return Promise.reject(neopleSearchFailure('internal'))
    }
    const entry = this.entries.get(account) ?? { reservations: [], waiting: new Set<Waiter>() }
    this.entries.set(account, entry)

    return new Promise<Lease>((resolve, reject) => {
      let released = false
      const release = (): void => {
        if (released) {
          return
        }
        released = true
        signal.removeEventListener('abort', waiter.cancel)
        entry.waiting.delete(waiter)
        const ownsAdmission = entry.owner === waiter
        if (ownsAdmission) {
          entry.owner = undefined
        }
        this.grantNext(entry)
        this.maintain(account, entry)
      }
      const assertActive = (): void => {
        const cannotUseLease = released || signal.aborted || this.closed
        if (cannotUseLease) {
          throw neopleSearchFailure('internal')
        }
      }
      const waiter: Waiter = {
        cancel: () => {
          reject(neopleSearchFailure('internal'))
          release()
        },
        grant: () =>
          resolve({
            assertCapacity: () => {
              assertActive()
              this.assertCapacity(entry, this.clock.now())
            },
            reserve: () => {
              assertActive()
              const calledAt = this.clock.now()
              this.assertCapacity(entry, calledAt)
              entry.reservations.push(calledAt)
              this.maintain(account, entry)
            },
            release
          })
      }
      entry.waiting.add(waiter)
      signal.addEventListener('abort', waiter.cancel, { once: true })
      this.grantNext(entry)
    })
  }

  private grantNext(entry: AccountEntry): void {
    const hasOwner = entry.owner != null
    const cannotGrant = hasOwner || this.closed
    if (cannotGrant) {
      return
    }
    const next = entry.waiting.values().next().value as Waiter | undefined
    const hasNext = next != null
    if (!hasNext) {
      return
    }
    entry.waiting.delete(next)
    entry.owner = next
    next.grant()
  }

  private prune(entry: AccountEntry, now: number): void {
    entry.reservations = entry.reservations.filter((reservedAt) => {
      const isRecent = reservedAt > now - windowMs
      return isRecent
    })
  }

  private assertCapacity(entry: AccountEntry, now: number): void {
    this.prune(entry, now)
    const isFull = entry.reservations.length >= capacity
    if (!isFull) {
      return
    }
    const oldest = entry.reservations[0]!
    const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
    throw neopleSearchFailure('limited', retryAfter)
  }

  private maintain(account: string, entry: AccountEntry): void {
    const hasTimer = entry.timer != null
    if (hasTimer) {
      this.clock.clearTimer(entry.timer)
    }
    entry.timer = undefined
    const now = this.clock.now()
    this.prune(entry, now)
    const hasReservations = entry.reservations.length > 0
    const hasOwner = entry.owner != null
    const hasWaiters = entry.waiting.size > 0
    const canDelete = !hasReservations && !hasOwner && !hasWaiters
    if (canDelete) {
      this.entries.delete(account)
    }
    const needsExpiry = hasReservations && !this.closed
    if (!needsExpiry) {
      return
    }
    const last = entry.reservations.at(-1)!
    entry.timer = this.clock.setTimer(() => this.maintain(account, entry), last + windowMs - now)
  }

  close(): void {
    this.closed = true
    for (const [account, entry] of this.entries) {
      for (const waiter of [...entry.waiting]) {
        waiter.cancel()
      }
      entry.owner?.cancel()
      this.maintain(account, entry)
    }
    this.entries.clear()
  }
}
