const resultPrefix = 'LDB_CREDENTIAL_NATIVE:'
const phaseResultError = 'Native credential phase failed; raw diagnostics were withheld.'

/**
 * @param {{ exitCode: number | null, expectedPhase: string, parsed: Record<string, unknown> | null }} input
 * @returns {{ phase: string, ok: true, decryptCalls: number, encryptionAvailabilityCalls: number }}
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
export function validateNativeCredentialPhaseResult({ exitCode, expectedPhase, parsed }) {
  const hasSuccessfulExit = exitCode === 0
  const hasSuccessfulResult = parsed?.ok === true
  const hasExpectedPhase = parsed?.phase === expectedPhase

  const isDecryptCountInteger = Number.isSafeInteger(parsed?.decryptCalls)
  let isDecryptCountNonnegative
  if (isDecryptCountInteger) {
    isDecryptCountNonnegative = parsed.decryptCalls >= 0
  }

  const isAvailabilityCountInteger = Number.isSafeInteger(parsed?.encryptionAvailabilityCalls)
  let isAvailabilityCountNonnegative
  if (isAvailabilityCountInteger) {
    isAvailabilityCountNonnegative = parsed.encryptionAvailabilityCalls >= 0
  }

  const hasValidDecryptCount = isDecryptCountInteger && isDecryptCountNonnegative === true
  const hasValidAvailabilityCount =
    isAvailabilityCountInteger && isAvailabilityCountNonnegative === true
  const succeeded =
    hasSuccessfulExit &&
    hasSuccessfulResult &&
    hasExpectedPhase &&
    hasValidDecryptCount &&
    hasValidAvailabilityCount
  if (!succeeded) {
    throw new Error(phaseResultError)
  }
  return {
    phase: expectedPhase,
    ok: true,
    decryptCalls: parsed.decryptCalls,
    encryptionAvailabilityCalls: parsed.encryptionAvailabilityCalls
  }
}

/**
 * @param {{ exitCode: number | null, expectedPhase: string, stdout: string }} input
 * @returns {{ phase: string, ok: true, decryptCalls: number, encryptionAvailabilityCalls: number }}
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
export function parseNativeCredentialPhaseResult({ exitCode, expectedPhase, stdout }) {
  const outputLines = stdout.split('\n')
  const line = outputLines.find((candidate) => candidate.startsWith(resultPrefix))
  const hasResult = line != null
  let parsed
  try {
    parsed = hasResult ? JSON.parse(line.slice(resultPrefix.length)) : null
  } catch {
    throw new Error(phaseResultError)
  }
  return validateNativeCredentialPhaseResult({ exitCode, expectedPhase, parsed })
}
