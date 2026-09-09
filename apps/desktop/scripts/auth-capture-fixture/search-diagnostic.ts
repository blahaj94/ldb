import assert from 'node:assert/strict'

type SearchDiagnosticValue = boolean | number

export type SearchDiagnostic = {
  stage: 'mixed'
  check:
    | 'capture-start'
    | 'mixed-state-ready'
    | 'initial-rate-wait'
    | 'scenario-selection-quiet'
    | 'first-retry-click'
    | 'first-retry-ready'
    | 'independent-retry'
  actual: Record<string, SearchDiagnosticValue>
  expected: Record<string, SearchDiagnosticValue>
}

export function createIndependentRetryDiagnostic({
  independentRetry
}: {
  independentRetry: boolean
}): SearchDiagnostic {
  return {
    stage: 'mixed',
    check: 'independent-retry',
    actual: { independent: independentRetry },
    expected: { independent: true }
  }
}

export function assertScenarioSelectionQuiet({
  currentRequests,
  expectedRequests,
  recordDiagnostic
}: {
  currentRequests: number
  expectedRequests: number
  recordDiagnostic: (diagnostic: SearchDiagnostic) => void
}): void {
  const requestDelta = currentRequests - expectedRequests
  recordDiagnostic({
    stage: 'mixed',
    check: 'scenario-selection-quiet',
    actual: { requestDelta },
    expected: { requestDelta: 0 }
  })
  assert.equal(currentRequests, expectedRequests)
}

export function rethrowMixedSearchFailure({
  error,
  diagnostic
}: {
  error: unknown
  diagnostic: SearchDiagnostic | null
}): never {
  const isErrorObject = error != null && typeof error === 'object'
  const details = isErrorObject
    ? (error as { code?: unknown; message?: unknown; generatedMessage?: unknown })
    : {}
  const isAssertion = details.code === 'ERR_ASSERTION'
  const isDeadline = details.message === 'Capture fixture observation deadline exceeded'
  const hasDiagnostic = diagnostic != null
  const canReportDiagnostic = hasDiagnostic && (isAssertion || isDeadline)
  if (canReportDiagnostic) {
    const kind = isAssertion ? 'assertion' : 'deadline'
    const generatedMessage =
      isAssertion && typeof details.generatedMessage === 'boolean' ? details.generatedMessage : null
    const record = { ...diagnostic, kind, generatedMessage }
    console.error(`Capture fixture search diagnostic: ${JSON.stringify(record)}`)
  }
  console.error('Capture fixture search stage FAIL: mixed')
  throw error
}
