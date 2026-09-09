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

const searchDiagnosticDefinitions = {
  'capture-start': {
    actual: { started: 'boolean' },
    expected: { started: true }
  },
  'mixed-state-ready': {
    actual: {
      regionMask: 'mask',
      statusesMatched: 'boolean',
      failureCount: 'slot-count',
      pendingCount: 'slot-count',
      limitedCount: 'slot-count'
    },
    expected: {
      regionMask: 15,
      statusesMatched: true,
      failureCount: 2,
      pendingCount: 1,
      limitedCount: 1
    }
  },
  'initial-rate-wait': {
    actual: {
      hasRetryWait: 'boolean',
      hasPositiveWait: 'boolean',
      retryDisabled: 'boolean'
    },
    expected: {
      hasRetryWait: true,
      hasPositiveWait: true,
      retryDisabled: true
    }
  },
  'scenario-selection-quiet': {
    actual: { requestDelta: 'request-delta' },
    expected: { requestDelta: 0 }
  },
  'first-retry-click': {
    actual: { clicked: 'boolean' },
    expected: { clicked: true }
  },
  'first-retry-ready': {
    actual: { succeeded: 'boolean', statusMatched: 'boolean' },
    expected: { succeeded: true, statusMatched: true }
  },
  'independent-retry': {
    actual: { independent: 'boolean', requestDelta: 'request-delta' },
    expected: { independent: true, requestDelta: 1 }
  }
}

/** @returns {boolean} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
function isDiagnosticValue(value, type) {
  if (type === 'boolean') {
    return typeof value === 'boolean'
  }
  const isInteger = Number.isSafeInteger(value)
  if (!isInteger) {
    return false
  }
  if (type === 'mask') {
    return value >= 0 && value <= 15
  }
  if (type === 'slot-count') {
    return value >= 0 && value <= 4
  }
  return type === 'request-delta' && value >= -20 && value <= 20
}

/** @returns {Record<string, unknown> | null} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
function readSearchDiagnostic(output) {
  const prefix = 'Capture fixture search diagnostic: '
  const lines = output.split('\n').filter((line) => line.startsWith(prefix))
  const hasOneRecord = lines.length === 1
  if (!hasOneRecord) {
    return null
  }
  try {
    const value = JSON.parse(lines[0].slice(prefix.length))
    const isObject = value != null && typeof value === 'object' && !Array.isArray(value)
    const keys = ['stage', 'check', 'kind', 'actual', 'expected', 'generatedMessage']
    const hasExactKeys = isObject && Object.keys(value).length === keys.length
    const hasKnownStage = hasExactKeys && value.stage === 'mixed'
    const definition = hasKnownStage ? searchDiagnosticDefinitions[value.check] : null
    const hasDefinition = definition != null
    const hasKnownKind = value.kind === 'assertion' || value.kind === 'deadline'
    const hasGeneratedMessage =
      (value.kind === 'assertion' && typeof value.generatedMessage === 'boolean') ||
      (value.kind === 'deadline' && value.generatedMessage === null)
    if (!hasDefinition || !hasKnownKind || !hasGeneratedMessage) {
      return null
    }
    const actualKeys = Object.keys(definition.actual)
    const actualIsObject =
      value.actual != null && typeof value.actual === 'object' && !Array.isArray(value.actual)
    const hasExactActualKeys =
      actualIsObject && Object.keys(value.actual).length === actualKeys.length
    const hasValidActual =
      hasExactActualKeys &&
      actualKeys.every((key) => isDiagnosticValue(value.actual[key], definition.actual[key]))
    const expectedKeys = Object.keys(definition.expected)
    const expectedIsObject =
      value.expected != null && typeof value.expected === 'object' && !Array.isArray(value.expected)
    const hasExactExpectedKeys =
      expectedIsObject && Object.keys(value.expected).length === expectedKeys.length
    const hasExpectedValues =
      hasExactExpectedKeys &&
      expectedKeys.every((key) => value.expected[key] === definition.expected[key])
    if (!hasValidActual || !hasExpectedValues) {
      return null
    }
    const actual = Object.fromEntries(actualKeys.map((key) => [key, value.actual[key]]))
    const expected = Object.fromEntries(expectedKeys.map((key) => [key, definition.expected[key]]))
    return {
      stage: 'mixed',
      check: value.check,
      kind: value.kind,
      actual,
      expected,
      generatedMessage: value.generatedMessage
    }
  } catch {
    return null
  }
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
        keys.every((key) => {
          const isSafeInteger = Number.isSafeInteger(value[key])
          const isNonnegative = isSafeInteger && value[key] >= 0
          const isWithinSampleLimit = isNonnegative && value[key] <= 4
          return isWithinSampleLimit
        })
      if (hasCounts) {
        const counts = Object.fromEntries(keys.map((key) => [key, value[key]]))
        console.log(`Capture fixture layout evidence: ${JSON.stringify(counts)}`)
      }
    } catch {
      // 정제된 보조 관측만 전달하며 원문은 출력하지 않는다.
    }
  }
  const diagnostic = readSearchDiagnostic(output)
  const hasDiagnostic = diagnostic != null
  if (hasDiagnostic) {
    console.log(`Capture fixture search diagnostic: ${JSON.stringify(diagnostic)}`)
  }
}

/** @returns {boolean} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
function hasGroupExited() {
  const hasChild = child?.pid != null
  if (!hasChild) {
    return true
  }
  try {
    process.kill(-child.pid, 0)
    return false
  } catch (error) {
    const isAbsent = error.code === 'ESRCH'
    if (isAbsent) {
      return true
    }
    throw new Error('Test child exit could not be confirmed')
  }
}

/** @returns {Promise<boolean>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
async function waitForExit() {
  const deadline = Date.now() + 5_000
  while (true) {
    const hasExited = hasGroupExited()
    if (hasExited) {
      return true
    }
    const hasExpired = Date.now() >= deadline
    if (hasExpired) {
      return false
    }
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
      if (hasPid) {
        process.kill(-child.pid, 'SIGTERM')
      }
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
  const hasExpectedMessage = output.includes(expectedMessage)
  assert.equal(hasExpectedMessage, true)
  if (isSearch) {
    const evidence = readSearchEvidence(output)
    const hasEvidence = evidence != null
    assert.equal(hasEvidence, true, 'Search evidence missing or incomplete')
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
    const hasMissingVideoWarning = output.includes(
      'Video was requested, but no video stream was provided'
    )
    assert.equal(hasMissingVideoWarning, false)
    const hasUnhandledRejectionWarning = output.includes('UnhandledPromiseRejectionWarning')
    assert.equal(hasUnhandledRejectionWarning, false)
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
  if (groupStopped) {
    await rm(testRoot, { recursive: true, force: true, maxRetries: 3 })
  }
}
