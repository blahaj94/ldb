import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// 일반 Vitest와 분리한 실제 child 종료 뒤 정리 검증이다. 기본 모드는 명시적 media 거절이다.
const appDirectory = fileURLToPath(new URL('../..', import.meta.url))
const testRoot = await mkdtemp(join(tmpdir(), 'ldb-capture-exit-check-'))
const isOcr = process.argv.includes('--ocr')
const isSearch = process.argv.includes('--search')
const isMedia = process.argv.includes('--media')
const command = isSearch
  ? 'capture:fixture:search'
  : isOcr
    ? 'capture:fixture:ocr'
    : isMedia
      ? 'capture:fixture:smoke'
      : 'capture:fixture:deny'
let child
let groupStopped = false

const expectedSearchEvidence = {
  emptyMask: 15,
  candidateMask: 15,
  independentRetry: true,
  timeout: true,
  rateWait: true,
  rateNoAutoGet: true,
  pendingCleanup: true,
  relogin: true,
  newCapture: true,
  displayRequests: 4,
  displayAllowed: 4,
  searchRequests: 20,
  pendingAborts: 5
}

/** @returns {Record<string, boolean | number> | null} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
function readSearchEvidence(output) {
  const prefix = 'Capture fixture search evidence: '
  const lines = output.split('\n').filter((line) => line.startsWith(prefix))
  const hasOneRecord = lines.length === 1
  if (!hasOneRecord) {
    return null
  }
  try {
    const value = JSON.parse(lines[0].slice(prefix.length))
    const isObject = value != null && typeof value === 'object' && !Array.isArray(value)
    const keys = Object.keys(expectedSearchEvidence)
    const hasExactCount = isObject && Object.keys(value).length === keys.length
    const hasRequiredValues =
      hasExactCount && keys.every((key) => value[key] === expectedSearchEvidence[key])
    if (!hasRequiredValues) {
      return null
    }
    return Object.fromEntries(keys.map((key) => [key, value[key]]))
  } catch {
    return null
  }
}

/** @returns {void} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
function reportSearchStages(output) {
  for (const line of output.split('\n')) {
    const stage = /^Capture fixture search stage(?: FAIL)?: ([a-z-]+)$/.exec(line)?.[1]
    const isStage = [
      'setup',
      'empty',
      'mixed',
      'rate-wait',
      'timeout',
      'pending-logout',
      'relogin',
      'layout',
      'final-cleanup'
    ].includes(stage)
    if (isStage) {
      console.log(line)
    }
    const prefix = 'Capture fixture layout evidence: '
    const isLayout = line.startsWith(prefix)
    if (!isLayout) {
      continue
    }
    try {
      const value = JSON.parse(line.slice(prefix.length))
      const keys = ['samples', 'overflowCount', 'themeMismatchCount']
      const isObject = value != null && typeof value === 'object' && !Array.isArray(value)
      const hasExactKeys = isObject && Object.keys(value).length === keys.length
      const hasCounts =
        hasExactKeys &&
        keys.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 4)
      if (hasCounts) {
        const counts = Object.fromEntries(keys.map((key) => [key, value[key]]))
        console.log(`Capture fixture layout evidence: ${JSON.stringify(counts)}`)
      }
    } catch {
      // 정제된 보조 관측만 전달하며 원문은 출력하지 않는다.
    }
  }
}

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
  child = spawn('pnpm', [command], {
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
  // Fixture 90초와 launcher 120초 제한 뒤 child/group 정리까지 기다린다.
  const deadline = setTimeout(
    () => {
      const hasPid = child.pid != null
      if (hasPid) process.kill(-child.pid, 'SIGTERM')
    },
    isSearch ? 240_000 : 150_000
  )
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
  if (isSearch) {
    reportSearchStages(output)
  }
  assert.equal(groupStopped, true, 'Test child group remains active')
  const expectsSuccess = isOcr || isMedia || isSearch
  const expectedCode = expectsSuccess ? 0 : 1
  const expectedMessage = isSearch
    ? 'Capture fixture search smoke PASS'
    : isOcr
      ? 'Capture fixture standalone OCR PASS'
      : isMedia
        ? 'Capture fixture smoke PASS'
        : 'Capture fixture media BLOCKED / smoke FAIL'
  assert.equal(code, expectedCode, 'Child result did not match the requested check')
  assert.equal(output.includes(expectedMessage), true)
  if (isSearch) {
    const evidence = readSearchEvidence(output)
    assert.equal(evidence != null, true, 'Search evidence missing or incomplete')
    console.log(`Capture fixture search evidence: ${JSON.stringify(evidence)}`)
  }
  if (isMedia) {
    const hasAllSyntheticMatches = output.includes(
      'Capture fixture synthetic matches: {"displayMatchedSlots":15,"nicknameMatchedSlots":15}'
    )
    assert.equal(hasAllSyntheticMatches, true)
    console.log('Capture fixture synthetic matches: display mask 15; notification mask 15')
  }
  const requiresNativeMedia = isMedia || isSearch
  if (requiresNativeMedia) {
    assert.equal(output.includes('Video was requested, but no video stream was provided'), false)
    assert.equal(output.includes('UnhandledPromiseRejectionWarning'), false)
    console.log('Capture fixture native denial warnings: 0')
  }
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
