import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { stopOwnedProcessGroup } from '../scripts/consumer-process-lifecycle.mjs'

// RED의 무제한 await도 assertion 결과로 반환하고, 실패한 작업은 finally에서 해제한다.
async function settleWithin({ operation, deadlineMs }) {
  let timer
  const settled = operation.then(
    () => ({ status: 'fulfilled' }),
    (error) => ({ status: 'rejected', error })
  )
  try {
    return await Promise.race([
      settled,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: 'deadline' }), deadlineMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function createControlledGroup(mode) {
  const child = { pid: 424242, exitCode: null, signalCode: null }
  const { promise: exited, resolve: release } = Promise.withResolvers()
  const signals = []
  const sleeps = []
  const permissionError = Object.assign(new Error('Group inspection denied'), { code: 'EPERM' })
  const cleanupError = new Error('Owned group signal failed')
  let groupExists = true
  let elapsedMs = 0

  function exit() {
    child.exitCode = 0
    release()
  }
  const hasExitedChild = ['absent', 'orphan', 'permission'].includes(mode)
  if (hasExitedChild) {
    exit()
  }
  const isInitiallyAbsent = mode === 'absent'
  if (isInitiallyAbsent) {
    groupExists = false
  }

  function kill(pid, signal) {
    assert.equal(pid, -child.pid, 'Only the supplied owned group may be addressed')
    const isProbe = signal === 0
    if (isProbe) {
      const isDenied = mode === 'permission'
      if (isDenied) {
        throw permissionError
      }
    } else {
      signals.push({ signal, elapsedMs })
      const hasSignalError = mode === 'cleanup-error'
      if (hasSignalError) {
        throw cleanupError
      }
      const isExitRace = mode === 'esrch'
      const isNormalTerm = mode === 'normal' && signal === 'SIGTERM'
      const canKill = mode !== 'persistent' && signal === 'SIGKILL'
      const shouldExit = isExitRace || isNormalTerm || canKill
      if (shouldExit) {
        groupExists = false
        exit()
      }
      const hasSuccessfulSignal = !isExitRace && shouldExit
      if (hasSuccessfulSignal) {
        return true
      }
    }
    if (!groupExists) {
      throw Object.assign(new Error('Owned group is absent'), { code: 'ESRCH' })
    }
    return true
  }

  return {
    child,
    exited,
    kill,
    now: () => elapsedMs,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds)
      elapsedMs += milliseconds
    },
    release,
    signals,
    sleeps,
    permissionError,
    cleanupError
  }
}

const unitCases = [
  { name: 'normal TERM exit remains successful', mode: 'normal', status: 'fulfilled' },
  { name: 'already exited and absent needs no signal', mode: 'absent', status: 'fulfilled' },
  { name: 'TERM refusal requires KILL and remains failure', mode: 'stubborn', status: 'rejected' },
  {
    name: 'child exit does not prove descendant group absence',
    mode: 'orphan',
    status: 'rejected'
  },
  {
    name: 'group remaining after KILL fails within both bounds',
    mode: 'persistent',
    status: 'rejected'
  },
  { name: 'permission failure is not group absence', mode: 'permission', status: 'rejected' },
  {
    name: 'ESRCH signal race succeeds after child exit and absence',
    mode: 'esrch',
    status: 'fulfilled'
  },
  {
    name: 'original inspection and cleanup errors are both retained',
    mode: 'cleanup-error',
    status: 'rejected'
  }
]

for (const { name, mode, status } of unitCases) {
  test(name, async () => {
    const group = createControlledGroup(mode)
    const originalError = new Error('HTTP inspection failed')
    const hasOriginalError = mode === 'cleanup-error'
    const options = hasOriginalError ? { ...group, originalError } : group
    const operation = stopOwnedProcessGroup(options)
    try {
      const outcome = await settleWithin({ operation, deadlineMs: 250 })
      assert.equal(outcome.status, status, 'Must settle from lifecycle handling, not test deadline')

      const needsEscalation = ['stubborn', 'orphan', 'persistent'].includes(mode)
      if (needsEscalation) {
        assert.deepEqual(group.signals, [
          { signal: 'SIGTERM', elapsedMs: 0 },
          { signal: 'SIGKILL', elapsedMs: 5000 }
        ])
        const isWithinCleanupBound = group.now() <= 7000
        assert.ok(isWithinCleanupBound, 'TERM plus KILL cleanup must be bounded at 7 seconds')
        const usesFiftyMillisecondPoll = group.sleeps.every((milliseconds) => {
          const isFiftyMilliseconds = milliseconds === 50
          return isFiftyMilliseconds
        })
        assert.ok(usesFiftyMillisecondPoll, 'Absence polling uses the approved 50ms interval')
      }
      const isAlreadyAbsent = mode === 'absent'
      if (isAlreadyAbsent) {
        assert.deepEqual(group.signals, [])
      }
      if (hasOriginalError) {
        const isAggregate = outcome.error instanceof AggregateError
        assert.ok(isAggregate, 'Both failures must remain inspectable')
        assert.deepEqual(outcome.error.errors, [originalError, group.cleanupError])
      }
    } finally {
      group.release()
      await operation.catch(() => {})
    }
  })
}

function createChildSource(ignoresTerm) {
  const termHandler = ignoresTerm ? "process.on('SIGTERM', () => {})" : ''
  // 소유 detached group의 독립 안전장치: test runner가 강제 종료돼도 12초 내 정리된다.
  const source = `
${termHandler}
setTimeout(() => process.kill(-process.pid, 'SIGKILL'), 12000)
setInterval(() => {}, 1000)
process.send('ready')
`
  return source
}

function isGroupAbsent(pid) {
  try {
    process.kill(-pid, 0)
    return false
  } catch (error) {
    const isAbsent = error.code === 'ESRCH'
    if (isAbsent) {
      return true
    }
    throw error
  }
}

for (const ignoresTerm of [false, true]) {
  const behavior = ignoresTerm ? 'TERM refusal fails after owned KILL' : 'normal TERM succeeds'
  test(`real Node detached child: ${behavior}`, async (context) => {
    const source = createChildSource(ignoresTerm)
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      detached: true,
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    })
    const exited = once(child, 'exit')
    const ready = once(child, 'message')
    try {
      const startup = await settleWithin({ operation: ready, deadlineMs: 2000 })
      assert.equal(startup.status, 'fulfilled', 'Synthetic child must install its handler first')
      const outcome = await settleWithin({
        operation: stopOwnedProcessGroup({ child, exited }),
        deadlineMs: 8000
      })
      const expectedStatus = ignoresTerm ? 'rejected' : 'fulfilled'
      assert.equal(
        outcome.status,
        expectedStatus,
        'Real Node termination must settle before safety cleanup'
      )
      const expectedSignal = ignoresTerm ? 'SIGKILL' : 'SIGTERM'
      assert.equal(child.signalCode, expectedSignal)
      const hasNoGroup = isGroupAbsent(child.pid)
      assert.ok(hasNoGroup, 'Child exit alone is not group cleanup')
    } finally {
      const hasGroup = !isGroupAbsent(child.pid)
      if (hasGroup) {
        process.kill(-child.pid, 'SIGKILL')
      }
      const cleanup = await settleWithin({ operation: exited, deadlineMs: 2000 })
      assert.equal(cleanup.status, 'fulfilled', 'Safety cleanup must reap the owned child')
      const hasNoGroup = isGroupAbsent(child.pid)
      assert.ok(hasNoGroup, 'Safety cleanup must leave no owned group')
      context.diagnostic(`owned group ${child.pid}: absent; safety KILL: ${hasGroup}`)
    }
  })
}
