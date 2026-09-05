import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePort } from '../src/port.js'

test('PORT accepts ASCII decimal integers in the allowed range', () => {
  assert.equal(parsePort('1'), 1)
  assert.equal(parsePort('65535'), 65_535)
  assert.equal(parsePort('00001'), 1)
})

test('PORT rejects missing, empty, out-of-range, and non-decimal values', () => {
  const invalidValues = [
    undefined,
    '',
    '0',
    '65536',
    '1.5',
    '+1',
    '-1',
    ' 1',
    '1 ',
    '１',
    '١',
  ]

  for (const value of invalidValues) {
    assert.throws(() => parsePort(value), { message: 'Invalid server configuration' })
  }
})
