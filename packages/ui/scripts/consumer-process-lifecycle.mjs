import { setTimeout as sleepMilliseconds } from 'node:timers/promises'

// 호출자가 detached: true로 직접 생성한 child만 받는 내부 helper다.
export async function stopOwnedProcessGroup(options) {
  const {
    child,
    exited,
    kill = process.kill,
    now = () => performance.now(),
    sleep = sleepMilliseconds
  } = options
  let hasExited = false
  let exitFailure
  exited.then(
    () => {
      hasExited = true
    },
    (error) => {
      exitFailure = { error }
    }
  )

  function hasGroup() {
    try {
      kill(-child.pid, 0)
      return true
    } catch (error) {
      const isAbsent = error.code === 'ESRCH'
      if (isAbsent) {
        return false
      }
      throw error
    }
  }

  function signalGroup(signal) {
    try {
      kill(-child.pid, signal)
    } catch (error) {
      const hasDisappeared = error.code === 'ESRCH'
      if (!hasDisappeared) {
        throw error
      }
    }
  }

  async function waitForCleanup(deadline) {
    while (true) {
      const hasExitFailure = exitFailure != null
      if (hasExitFailure) {
        throw exitFailure.error
      }
      const groupExists = hasGroup()
      const isClean = hasExited && !groupExists
      if (isClean) {
        return true
      }
      const remainingMs = deadline - now()
      const hasExpired = remainingMs <= 0
      if (hasExpired) {
        return false
      }
      await sleep(Math.min(50, remainingMs))
    }
  }

  try {
    const hasIntegerPid = Number.isSafeInteger(child.pid)
    if (!hasIntegerPid) {
      throw new Error('Cannot identify the owned detached process group')
    }
    const hasOwnedGroupId = child.pid > 1
    if (!hasOwnedGroupId) {
      throw new Error('Cannot identify the owned detached process group')
    }
    const termDeadline = now() + 5000
    const groupExists = hasGroup()
    if (groupExists) {
      signalGroup('SIGTERM')
    }
    const isCleanAfterTerm = await waitForCleanup(termDeadline)
    if (isCleanAfterTerm) {
      return
    }

    const killDeadline = now() + 2000
    const hasRemainingGroup = hasGroup()
    if (hasRemainingGroup) {
      signalGroup('SIGKILL')
    }
    const isCleanAfterKill = await waitForCleanup(killDeadline)
    if (!isCleanAfterKill) {
      throw new Error('Owned process group cleanup could not confirm child exit and group absence')
    }
    throw new Error(
      'Owned process group exceeded the SIGTERM grace period; cleanup required escalation'
    )
  } catch (cleanupError) {
    const hasOriginalError = Object.hasOwn(options, 'originalError')
    if (hasOriginalError) {
      throw new AggregateError(
        [options.originalError, cleanupError],
        'Consumer inspection failed and owned process group cleanup also failed',
        { cause: options.originalError }
      )
    }
    throw cleanupError
  }
}
