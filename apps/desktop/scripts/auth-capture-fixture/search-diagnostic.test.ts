import assert from 'node:assert/strict'
import { expect, it, vi } from 'vitest'
import {
  assertScenarioSelectionQuiet,
  rethrowMixedSearchFailure,
  type SearchDiagnostic
} from './search-diagnostic'

it('selection count assertion과 mixed 진단이 원래 오류 object를 보존한다', () => {
  let diagnostic: SearchDiagnostic | null = null
  let originalError: unknown

  try {
    assertScenarioSelectionQuiet({
      currentRequests: 21,
      expectedRequests: 20,
      recordDiagnostic: (record) => {
        diagnostic = record
      }
    })
  } catch (error) {
    originalError = error
  }

  expect(originalError).toBeInstanceOf(assert.AssertionError)
  expect(originalError).toMatchObject({ actual: 21, expected: 20, generatedMessage: true })
  expect(diagnostic).toEqual({
    stage: 'mixed',
    check: 'scenario-selection-quiet',
    actual: { requestDelta: 1 },
    expected: { requestDelta: 0 }
  })

  const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  let rethrownError: unknown
  try {
    rethrowMixedSearchFailure({ error: originalError, diagnostic })
  } catch (error) {
    rethrownError = error
  }

  expect(rethrownError).toBe(originalError)
  expect(report).toHaveBeenNthCalledWith(
    1,
    'Capture fixture search diagnostic: ' +
      JSON.stringify({
        stage: 'mixed',
        check: 'scenario-selection-quiet',
        actual: { requestDelta: 1 },
        expected: { requestDelta: 0 },
        kind: 'assertion',
        generatedMessage: true
      })
  )
  expect(report).toHaveBeenNthCalledWith(2, 'Capture fixture search stage FAIL: mixed')
  report.mockRestore()
})
