/* global AbortController */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settled } from './login-test-control.mjs'

function clock() {
  let now = 0
  let nextTimer = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimer(callback, delay) {
      const timer = ++nextTimer
      timers.set(timer, { callback, at: now + delay })
      return timer
    },
    clearTimer: (timer) => timers.delete(timer),
    advance(time) {
      now = time
      for (const [id, timer] of timers) {
        const isDue = timer.at <= now
        if (!isDue) continue
        timers.delete(id)
        timer.callback()
      }
    },
    get timerCount() { return timers.size },
  }
}

async function reserve(admission, account = 'account') {
  const controller = new AbortController()
  const lease = await admission.acquire(account, controller.signal)
  try {
    lease.assertCapacity()
    lease.reserve()
  } finally {
    lease.release()
  }
}

function assertLimited(lease, seconds) {
  assert.throws(() => lease.assertCapacity(), (error) => {
    assert.equal(error.status, 429)
    assert.equal(error.body.error.code, 'SEARCH_RATE_LIMITED')
    assert.equal(error.retryAfter, seconds)
    return true
  })
}

test('search quota expires at exactly 60000ms and rejected attempts do not extend the window', async () => {
  const { SearchAdmission } = await import('../dist/characters/search-admission.js')
  const time = clock()
  const admission = new SearchAdmission(time)
  for (let count = 0; count < 10; count += 1) await reserve(admission)
  const controller = new AbortController()
  for (const [now, retryAfter] of [[0, 60], [58_001, 2], [59_999, 1]]) {
    time.advance(now)
    const lease = await admission.acquire('account', controller.signal)
    assertLimited(lease, retryAfter)
    lease.release()
  }
  time.advance(60_000)
  await reserve(admission)
  assert.equal(admission.entryCount, 1)
  time.advance(120_000)
  assert.equal(admission.entryCount, 0)
  assert.equal(time.timerCount, 0)
})

test('search accounts serialize only admission and reserve using the final clock', async () => {
  const { SearchAdmission } = await import('../dist/characters/search-admission.js')
  const time = clock()
  const admission = new SearchAdmission(time)
  const owner = await admission.acquire('account', new AbortController().signal)
  owner.assertCapacity()
  let waiterAcquired = false
  const pending = admission.acquire('account', new AbortController().signal).then((lease) => {
    waiterAcquired = true
    return lease
  })
  await reserve(admission, 'other-account')
  assert.equal(waiterAcquired, false)
  time.advance(1000)
  owner.reserve()
  owner.release()
  const waiter = await pending
  waiter.release()
  for (let count = 1; count < 10; count += 1) await reserve(admission)
  time.advance(60_000)
  const beforeExactExpiry = await admission.acquire('account', new AbortController().signal)
  assertLimited(beforeExactExpiry, 1)
  beforeExactExpiry.release()
  time.advance(61_000)
  assert.equal(admission.entryCount, 0)
})

test('search cancellation removes queued references and no-reservation account entries', async () => {
  const { SearchAdmission } = await import('../dist/characters/search-admission.js')
  const admission = new SearchAdmission(clock())
  const ownerController = new AbortController()
  const owner = await admission.acquire('account', ownerController.signal)
  const waiterController = new AbortController()
  const pending = settled(admission.acquire('account', waiterController.signal))
  waiterController.abort()
  const rejected = await pending
  assert.equal(rejected.error.status, 500)
  assert.equal(admission.entryCount, 1)
  ownerController.abort()
  owner.release()
  assert.equal(admission.entryCount, 0)
  await assert.rejects(admission.acquire('account', waiterController.signal), { status: 500 })
  assert.equal(admission.entryCount, 0)
})

test('search reservation expiry cannot replace an account entry with live admission', async () => {
  const { SearchAdmission } = await import('../dist/characters/search-admission.js')
  const time = clock()
  const admission = new SearchAdmission(time)
  await reserve(admission)
  const owner = await admission.acquire('account', new AbortController().signal)
  time.advance(60_000)
  assert.equal(admission.entryCount, 1)
  let nextAcquired = false
  const next = admission.acquire('account', new AbortController().signal).then((lease) => {
    nextAcquired = true
    return lease
  })
  await Promise.resolve()
  assert.equal(nextAcquired, false)
  owner.release()
  const nextLease = await next
  nextLease.release()
  assert.equal(admission.entryCount, 0)
})
