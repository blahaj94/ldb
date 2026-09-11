import { describe, expect, it } from 'vitest'
import {
  parseNativeCredentialPhaseResult,
  validateNativeCredentialPhaseResult
} from './phase-result.mjs'

const validResult = {
  phase: 'write',
  ok: true,
  decryptCalls: 1,
  encryptionAvailabilityCalls: 2
}

/** @returns {string} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
function outputFor(result) {
  return `ignored\nLDB_CREDENTIAL_NATIVE:${JSON.stringify(result)}\n`
}

describe('credential-store-native phase result validation', () => {
  it('parses and returns both validated counters', () => {
    expect(
      parseNativeCredentialPhaseResult({
        exitCode: 0,
        expectedPhase: 'write',
        stdout: outputFor(validResult)
      })
    ).toEqual(validResult)
  })

  it.each([
    ['missing decrypt counter', { decryptCalls: undefined }],
    ['non-integer decrypt counter', { decryptCalls: 1.5 }],
    ['negative decrypt counter', { decryptCalls: -1 }],
    ['unsafe availability counter', { encryptionAvailabilityCalls: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative availability counter', { encryptionAvailabilityCalls: -1 }]
  ])('%s is rejected with the sanitized phase error', (_name, changes) => {
    const result = { ...validResult, ...changes }

    expect(() =>
      parseNativeCredentialPhaseResult({
        exitCode: 0,
        expectedPhase: 'write',
        stdout: outputFor(result)
      })
    ).toThrow('Native credential phase failed; raw diagnostics were withheld.')
  })

  it('keeps the second counter check and protects non-integer property access', () => {
    const accesses = []
    const parsed = new Proxy(
      {
        ...validResult,
        decryptCalls: 'invalid'
      },
      {
        get(target, property, receiver) {
          const isDecryptCounter = property === 'decryptCalls'
          const isAvailabilityCounter = property === 'encryptionAvailabilityCalls'
          const isCounterProperty = isDecryptCounter || isAvailabilityCounter

          if (isCounterProperty) {
            accesses.push(property)
          }
          return Reflect.get(target, property, receiver)
        }
      }
    )

    expect(() =>
      validateNativeCredentialPhaseResult({
        exitCode: 0,
        expectedPhase: 'write',
        parsed
      })
    ).toThrow('Native credential phase failed; raw diagnostics were withheld.')
    expect(accesses).toEqual([
      'decryptCalls',
      'encryptionAvailabilityCalls',
      'encryptionAvailabilityCalls'
    ])
  })
})
