import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// 일반 Vitest와 분리한 실제 deny-all 실패 종료 검증이다.
const appDirectory = fileURLToPath(new URL('../..', import.meta.url))
const testRoot = await mkdtemp(join(tmpdir(), 'ldb-capture-exit-check-'))
let child
let groupStopped = false

/** @returns {boolean} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
function hasGroupExited() {
  const hasChild = child?.pid != null
  if (!hasChild) return true
  try {
    process.kill(-child.pid, 0)
    return false
  } catch (error) {
    const isAbsent = error.code === 'ESRCH'
    if (isAbsent) return true
    throw new Error('Test child exit could not be confirmed')
  }
}

/** @returns {Promise<boolean>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
async function waitForExit() {
  const deadline = Date.now() + 5_000
  while (true) {
    if (hasGroupExited()) return true
    const hasExpired = Date.now() >= deadline
    if (hasExpired) return false
    await delay(50)
  }
}

try {
  child = spawn('pnpm', ['capture:fixture:smoke'], {
    cwd: appDirectory,
    env: { ...process.env, TMPDIR: testRoot },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  const deadline = setTimeout(() => {
    const hasPid = child.pid != null
    if (hasPid) process.kill(-child.pid, 'SIGTERM')
  }, 60_000)
  let code
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Test child could not start')))
      child.once('close', resolve)
    })
  } finally {
    clearTimeout(deadline)
  }
  groupStopped = await waitForExit()
  console.log(`Capture fixture child exit: ${code}; group stopped: ${groupStopped}`)
  assert.equal(groupStopped, true, 'Test child group remains active')
  assert.equal(code, 1, 'Deny-all media smoke must fail')
  assert.equal(output.includes('Capture fixture media BLOCKED / smoke FAIL'), true)
  const remaining = (await readdir(testRoot)).filter((name) => {
    const isCaptureProfile = name.startsWith('ldb-auth-capture-fixture-')
    return isCaptureProfile
  })
  console.log(`Capture fixture profiles after child exit: ${remaining.length}`)
  assert.equal(remaining.length, 0, 'Capture profile remains after Electron exit')
  console.log('Capture fixture post-exit check PASS')
} catch {
  console.error('Capture fixture post-exit check FAIL')
  process.exitCode = 1
} finally {
  if (!groupStopped) {
    const hasPid = child?.pid != null
    if (hasPid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* 아래에서 종료를 확인한다. */
      }
    }
    groupStopped = await waitForExit()
  }
  if (groupStopped) await rm(testRoot, { recursive: true, force: true, maxRetries: 3 })
}
