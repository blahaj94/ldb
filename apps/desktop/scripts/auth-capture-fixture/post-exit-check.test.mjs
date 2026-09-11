import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(),
  create: vi.fn(),
  read: vi.fn(),
  remove: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: fixture.spawn }))
vi.mock('node:fs/promises', () => ({
  mkdtemp: fixture.create,
  readdir: fixture.read,
  rm: fixture.remove
}))
let originalExitCode
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  originalExitCode = process.exitCode
  process.exitCode = 0
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'post-exit-check.mjs', '--media'])
  fixture.create.mockResolvedValue('/synthetic/owned-exit-check')
  fixture.read.mockResolvedValue([])
  fixture.remove.mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('60초 이후 내부 실행과 정리를 마친 정상 child를 outer timeout이 조기 종료하지 않는다', async () => {
  let hasExited = false
  const child = Object.assign(new EventEmitter(), {
    pid: 424242,
    stdout: new EventEmitter(),
    stderr: new EventEmitter()
  })
  fixture.spawn.mockImplementation(() => {
    setTimeout(() => {
      child.stdout.emit(
        'data',
        'Capture fixture synthetic matches: {"displayMatchedSlots":15,"nicknameMatchedSlots":15}\nCapture fixture smoke PASS'
      )
      hasExited = true
      child.emit('close', 0)
    }, 125_000)
    return child
  })
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    const isInspection = signal === 0
    if (isInspection) {
      if (hasExited) {
        throw Object.assign(new Error('Gone'), { code: 'ESRCH' })
      }
      return true
    }
    hasExited = true
    child.emit('close', 1)
    return true
  })
  const execution = import('./post-exit-check.mjs')
  await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce())

  await vi.advanceTimersByTimeAsync(125_000)
  await execution

  expect(process.kill).not.toHaveBeenCalledWith(-424242, 'SIGTERM')
  expect(console.log).toHaveBeenCalledWith('Capture fixture post-exit check PASS')
  expect(process.exitCode).toBe(0)
  expect(fixture.remove).toHaveBeenCalledExactlyOnceWith('/synthetic/owned-exit-check', {
    recursive: true,
    force: true,
    maxRetries: 3
  })
})

const searchEvidence = {
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

/** @returns {Promise<void>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
async function runSearchChild({
  evidence = searchEvidence,
  diagnostic = null,
  layoutEvidence = null,
  completionMs = 1,
  exitCode = 0
} = {}) {
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'post-exit-check.mjs', '--search'])
  let stopped = false
  const child = Object.assign(new EventEmitter(), {
    pid: 424242,
    stdout: new EventEmitter(),
    stderr: new EventEmitter()
  })
  fixture.spawn.mockImplementation(() => {
    setTimeout(() => {
      const hasDiagnostic = diagnostic != null
      if (hasDiagnostic) {
        child.stderr.emit(
          'data',
          `Capture fixture search diagnostic: ${JSON.stringify(diagnostic)}\n`
        )
      }
      const hasLayoutEvidence = layoutEvidence != null
      if (hasLayoutEvidence) {
        child.stderr.emit(
          'data',
          `Capture fixture layout evidence: ${JSON.stringify(layoutEvidence)}\n`
        )
      }
      const hasEvidence = evidence != null
      if (hasEvidence) {
        child.stdout.emit('data', `Capture fixture search evidence: ${JSON.stringify(evidence)}\n`)
      }
      const result = exitCode === 0 ? 'PASS' : 'FAIL'
      child.stdout.emit(
        'data',
        `Capture fixture search smoke ${result}\nCapture fixture cleanup PASS\n`
      )
      stopped = true
      child.emit('close', exitCode)
    }, completionMs)
    return child
  })
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    const isInspection = signal === 0
    if (isInspection) {
      if (stopped) {
        throw Object.assign(new Error('Gone'), { code: 'ESRCH' })
      }
      return true
    }
    stopped = true
    child.emit('close', 1)
    return true
  })
  const execution = import('./post-exit-check.mjs')
  await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(completionMs)
  await execution
}

it('검색 전용 mode는 검증된 검색 evidence와 child/group/profile 종료를 함께 요구한다', async () => {
  await runSearchChild()
  expect(fixture.spawn.mock.calls[0][1]).toEqual(['capture:fixture:search'])
  expect(console.log).toHaveBeenCalledWith('Capture fixture post-exit check PASS')
  expect(process.exitCode).toBe(0)
  expect(fixture.read).toHaveBeenCalledOnce()
  expect(fixture.remove).toHaveBeenCalledOnce()
})

it('새 검색 mode의 긴 실행을 기존 media 150초 상한으로 조기 종료하지 않는다', async () => {
  await runSearchChild({ completionMs: 155_000 })
  expect(process.kill).not.toHaveBeenCalledWith(-424242, 'SIGTERM')
  expect(console.log).toHaveBeenCalledWith('Capture fixture post-exit check PASS')
  expect(process.exitCode).toBe(0)
})

it.each([
  { name: 'missing evidence', evidence: null },
  { name: 'failed rate limit check', evidence: { ...searchEvidence, rateNoAutoGet: false } },
  { name: 'unexpected field', evidence: { ...searchEvidence, raw: 'synthetic-private-value' } },
  { name: 'missing native stream evidence', evidence: { ...searchEvidence, displayAllowed: 0 } }
])('$name은 child 성공 문구만으로 검색 검증을 통과시키지 않는다', async ({ evidence }) => {
  await runSearchChild({ evidence })
  expect(process.exitCode).toBe(1)
  expect(console.error).toHaveBeenCalledWith('Capture fixture post-exit check FAIL')
  const logged = JSON.stringify([
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.error).mock.calls
  ])
  expect(logged.includes('synthetic-private-value')).toBe(false)
})

const mixedDeadlineDiagnostic = {
  stage: 'mixed',
  check: 'mixed-state-ready',
  kind: 'deadline',
  actual: {
    regionMask: 15,
    statusesMatched: false,
    failureCount: 1,
    pendingCount: 2,
    limitedCount: 1
  },
  expected: {
    regionMask: 15,
    statusesMatched: true,
    failureCount: 2,
    pendingCount: 1,
    limitedCount: 1
  },
  generatedMessage: null
}

it('검색 실패 child의 정제된 mixed deadline 진단을 한 record로 전달한다', async () => {
  await runSearchChild({ evidence: null, diagnostic: mixedDeadlineDiagnostic, exitCode: 1 })

  expect(console.log).toHaveBeenCalledWith(
    `Capture fixture search diagnostic: ${JSON.stringify(mixedDeadlineDiagnostic)}`
  )
  expect(process.exitCode).toBe(1)
})

it('검색 성공 child가 진단 record를 주입해도 전달하지 않고 성공 의미를 유지한다', async () => {
  await runSearchChild({ diagnostic: mixedDeadlineDiagnostic })

  const logged = JSON.stringify(vi.mocked(console.log).mock.calls)
  expect(logged.includes('Capture fixture search diagnostic:')).toBe(false)
  expect(console.log).toHaveBeenCalledWith('Capture fixture post-exit check PASS')
  expect(process.exitCode).toBe(0)
})

it('검색 실패 child의 정제된 mixed assertion 진단을 전달한다', async () => {
  const diagnostic = {
    stage: 'mixed',
    check: 'initial-rate-wait',
    kind: 'assertion',
    actual: { hasRetryWait: true, hasPositiveWait: false, retryDisabled: false },
    expected: { hasRetryWait: true, hasPositiveWait: true, retryDisabled: true },
    generatedMessage: true
  }

  await runSearchChild({ evidence: null, diagnostic, exitCode: 1 })

  expect(console.log).toHaveBeenCalledWith(
    `Capture fixture search diagnostic: ${JSON.stringify(diagnostic)}`
  )
  expect(process.exitCode).toBe(1)
})

it('actual 진단이 부적합해도 expected 검사를 수행한다', async () => {
  let hasExpectedRead = false
  const parsedDiagnostic = {
    stage: 'mixed',
    check: 'capture-start',
    kind: 'assertion',
    actual: { started: 'invalid' },
    expected: {},
    generatedMessage: false
  }
  Object.defineProperty(parsedDiagnostic.expected, 'started', {
    enumerable: true,
    get() {
      hasExpectedRead = true
      return true
    }
  })
  vi.spyOn(JSON, 'parse').mockReturnValue(parsedDiagnostic)

  await runSearchChild({
    evidence: null,
    diagnostic: {
      stage: 'mixed',
      check: 'capture-start',
      kind: 'assertion',
      actual: { started: true },
      expected: { started: true },
      generatedMessage: false
    },
    exitCode: 1
  })

  expect(hasExpectedRead).toBe(true)
  expect(process.exitCode).toBe(1)
})

it('검색 실패 child의 유효한 layout evidence를 정제해 전달한다', async () => {
  const layoutEvidence = { samples: 2, overflowCount: 0, themeMismatchCount: 1 }

  await runSearchChild({ evidence: null, layoutEvidence, exitCode: 1 })

  expect(console.log).toHaveBeenCalledWith(
    `Capture fixture layout evidence: ${JSON.stringify(layoutEvidence)}`
  )
  expect(process.exitCode).toBe(1)
})

it('검색 실패 child의 부적합한 layout evidence는 전달하지 않는다', async () => {
  const layoutEvidence = {
    samples: 5,
    overflowCount: 0,
    themeMismatchCount: 1,
    raw: 'synthetic-private-value'
  }

  await runSearchChild({ evidence: null, layoutEvidence, exitCode: 1 })

  const logged = JSON.stringify(vi.mocked(console.log).mock.calls)
  expect(logged.includes('Capture fixture layout evidence:')).toBe(false)
  expect(logged.includes('synthetic-private-value')).toBe(false)
  expect(process.exitCode).toBe(1)
})

it.each([
  {
    name: 'deadline-only check의 assertion',
    diagnostic: { ...mixedDeadlineDiagnostic, kind: 'assertion', generatedMessage: true }
  },
  {
    name: 'assertion-only check의 deadline',
    diagnostic: {
      stage: 'mixed',
      check: 'initial-rate-wait',
      kind: 'deadline',
      actual: { hasRetryWait: true, hasPositiveWait: false, retryDisabled: false },
      expected: { hasRetryWait: true, hasPositiveWait: true, retryDisabled: true },
      generatedMessage: null
    }
  }
])('$name 진단은 전달하지 않는다', async ({ diagnostic }) => {
  await runSearchChild({ evidence: null, diagnostic, exitCode: 1 })

  const logged = JSON.stringify(vi.mocked(console.log).mock.calls)
  expect(logged.includes('Capture fixture search diagnostic:')).toBe(false)
})

it('independent retry 진단은 이미 계산된 슬롯 독립성 boolean만 전달한다', async () => {
  const diagnostic = {
    stage: 'mixed',
    check: 'independent-retry',
    kind: 'assertion',
    actual: { independent: false },
    expected: { independent: true },
    generatedMessage: true
  }

  await runSearchChild({ evidence: null, diagnostic, exitCode: 1 })

  expect(console.log).toHaveBeenCalledWith(
    `Capture fixture search diagnostic: ${JSON.stringify(diagnostic)}`
  )
  expect(process.exitCode).toBe(1)
})

it('independent retry 진단의 미관측 request delta는 전달하지 않는다', async () => {
  const diagnostic = {
    stage: 'mixed',
    check: 'independent-retry',
    kind: 'assertion',
    actual: { independent: false, requestDelta: 0 },
    expected: { independent: true, requestDelta: 1 },
    generatedMessage: true
  }

  await runSearchChild({ evidence: null, diagnostic, exitCode: 1 })

  const logged = JSON.stringify(vi.mocked(console.log).mock.calls)
  expect(logged.includes('Capture fixture search diagnostic:')).toBe(false)
})

it.each([
  {
    name: 'unexpected field',
    diagnostic: { ...mixedDeadlineDiagnostic, raw: 'synthetic-private-value' }
  },
  {
    name: 'nested private value',
    diagnostic: {
      ...mixedDeadlineDiagnostic,
      actual: { ...mixedDeadlineDiagnostic.actual, requestId: 'synthetic-private-value' }
    }
  },
  {
    name: 'out-of-range count',
    diagnostic: {
      ...mixedDeadlineDiagnostic,
      actual: { ...mixedDeadlineDiagnostic.actual, failureCount: 5 }
    }
  }
])('$name 진단은 전달하지 않는다', async ({ diagnostic }) => {
  await runSearchChild({ evidence: null, diagnostic, exitCode: 1 })

  const logged = JSON.stringify(vi.mocked(console.log).mock.calls)
  expect(logged.includes('Capture fixture search diagnostic:')).toBe(false)
  expect(logged.includes('synthetic-private-value')).toBe(false)
})

it('중복된 진단 record는 전달하지 않는다', async () => {
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'post-exit-check.mjs', '--search'])
  let stopped = false
  const child = Object.assign(new EventEmitter(), {
    pid: 424242,
    stdout: new EventEmitter(),
    stderr: new EventEmitter()
  })
  fixture.spawn.mockImplementation(() => {
    setTimeout(() => {
      const line = `Capture fixture search diagnostic: ${JSON.stringify(mixedDeadlineDiagnostic)}\n`
      child.stderr.emit('data', `${line}${line}`)
      child.stderr.emit('data', 'Capture fixture search smoke FAIL\n')
      stopped = true
      child.emit('close', 1)
    }, 1)
    return child
  })
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0 && stopped) {
      throw Object.assign(new Error('Gone'), { code: 'ESRCH' })
    }
    return true
  })

  const execution = import('./post-exit-check.mjs')
  await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(1)
  await execution

  const logged = JSON.stringify(vi.mocked(console.log).mock.calls)
  expect(logged.includes('Capture fixture search diagnostic:')).toBe(false)
})
