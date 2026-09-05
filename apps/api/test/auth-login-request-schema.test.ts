import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { EntitySchemaOptions } from 'typeorm'
import { AuthLoginRequestSchema } from '../src/database/schemas/auth-login-requests.js'
import type { AuthLoginRequest } from '../src/database/schemas/auth-login-requests.js'

// 8614006의 compiled metadata를 고정한다. 현재 schema/helper에서 expected 값을 만들지 않는다.
test('AuthLoginRequest refactor preserves flat columns, defaults and exact named CHECK SQL', async () => {
  const expected: EntitySchemaOptions<AuthLoginRequest> = JSON.parse(await readFile(
    new URL('../../test/fixtures/auth-login-request-schema.json', import.meta.url), 'utf8',
  ))
  const actual = AuthLoginRequestSchema.options
  const sortChecks = (checks: typeof actual.checks) => [...(checks ?? [])].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  assert.deepEqual(Object.keys(actual.columns), Object.keys(expected.columns))
  assert.deepEqual({ ...actual, checks: sortChecks(actual.checks) }, { ...expected, checks: sortChecks(expected.checks) })
})
