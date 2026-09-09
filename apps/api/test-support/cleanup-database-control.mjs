import assert from 'node:assert/strict'
import { blockedBy, bounded, instrument, settled } from './login-test-control.mjs'

export function targets({ sql, parameters, verb, table, id }) {
  const hasVerb = sql.startsWith(verb)
  const hasTable = sql.includes(table)
  const hasId = parameters?.includes(id) === true
  return hasVerb && hasTable && hasId
}

// 삭제 SQL은 실제로 실행한 채 commit만 보류한다. 경합 상대의 backend가 이 잠금을 기다리는지 확인한다.
export async function withCleanupDeletionHeld({ source, cleanup, table, id, operation }) {
  const held = Promise.withResolvers()
  const release = Promise.withResolvers()
  const waiter = Promise.withResolvers()
  let owner
  const restore = instrument(source, {
    query: async ({ runner, sql, parameters, query, run }) => {
      const isDeletion = targets({ sql, parameters, verb: 'DELETE', table, id })
      const isTargetRead = targets({ sql, parameters, verb: 'SELECT', table, id })
      const hasWriteLock = sql.includes('FOR UPDATE')
      const hasOwner = owner != null
      const isOtherRunner = runner !== owner
      const isWaitingLock = isTargetRead && hasWriteLock && hasOwner && isOtherRunner
      if (isWaitingLock) {
        waiter.resolve((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
      }
      const result = await run()
      if (isDeletion) {
        owner = runner
        held.resolve((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
        await release.promise
      }
      return result
    }
  })
  const pending = settled(cleanup(source))
  try {
    const pid = await bounded(held.promise)
    await operation({ pid, waiter: waiter.promise, release: () => release.resolve(), pending })
  } finally {
    release.resolve()
    await pending
    restore()
  }
  assert.equal((await pending).error, undefined)
}

export async function cleanupWaitingOn({ source, cleanup, table, id, blocker, unlock }) {
  const observed = Promise.withResolvers()
  const restore = instrument(source, {
    query: async ({ sql, parameters, query, run }) => {
      const isTargetLock =
        targets({ sql, parameters, verb: 'SELECT', table, id }) && sql.includes('FOR UPDATE')
      if (isTargetLock) {
        observed.resolve((await query('SELECT pg_backend_pid() AS pid'))[0].pid)
      }
      return run()
    }
  })
  const pending = settled(cleanup(source))
  try {
    await blockedBy(source, await bounded(observed.promise), blocker)
    await unlock()
    assert.equal((await pending).error, undefined)
  } finally {
    await unlock()
    await pending
    restore()
  }
}
