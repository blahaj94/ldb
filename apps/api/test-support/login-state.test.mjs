import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { URLSearchParams } from 'node:url'
import { test } from 'node:test'
import { opaque } from './login-fixtures.mjs'
import { digest } from './login-database.mjs'

const { completeLoginCallback } = await import('../dist/auth/login/callback.js')

test('expired processing callback read commits terminal cleanup after an uncertain prior claim', async () => {
  const state = opaque(), binding = opaque(), time = new Date('2026-09-06T00:10:00Z')
  const stored = {
    id: randomUUID(), provider: 'google', status: 'processing', expiresAt: time,
    stateHash: digest(state), browserBindingHash: digest(binding),
  }
  let updates = 0, providerCalls = 0
  const manager = {
    query: async () => [{ now: time }],
    getRepository: () => ({
      findOne: async () => stored,
      update: async (_where, patch) => { updates++; Object.assign(stored, patch) },
    }),
  }
  const deps = {
    dataSource: { transaction: async (_isolation, operation) => operation(manager) },
    verifyProvider: async () => { providerCalls++ },
  }
  await assert.rejects(() => completeLoginCallback(deps, 'google', new URLSearchParams({ state, code: 'fixture-provider-code' }), `__Host-ldb-login-${stored.id}=${binding}`),
    { code: 'LOGIN_REQUEST_INVALID' })
  assert.equal(providerCalls, 0)
  assert.equal(updates, 1)
  assert.equal(stored.status, 'failed')
  assert.equal(stored.stateHash, null)
})
