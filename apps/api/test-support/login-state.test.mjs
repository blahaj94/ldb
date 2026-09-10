import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { URLSearchParams } from 'node:url'
import { test } from 'node:test'
import { opaque, registration } from './login-fixtures.mjs'
import { digest } from './login-database.mjs'
import { bounded, settled } from './login-test-control.mjs'

const { completeLoginCallback } = await import('../dist/auth/login/callback.js')
const { authorizeLogin } = await import('../dist/auth/login/start.js')
const { exchangeLogin } = await import('../dist/auth/login/exchange.js')
const { LOGIN } = await import('../dist/constants/login.js')

for (const outcome of ['success', 'rejection', 'invalid identity', 'timeout']) {
  test(`provider proof references are released before the next DB wait: ${outcome}`, async (t) => {
    const isTimeoutOutcome = outcome === 'timeout'
    if (isTimeoutOutcome) {
      t.mock.timers.enable({ apis: ['setTimeout'] })
    }

    const state = opaque()
    const binding = opaque()
    const verifier = opaque()
    const snapshot = registration()
    const stored = {
      id: randomUUID(),
      provider: 'google',
      providerConfigVersion: snapshot.version,
      returnTargetId: snapshot.returnTarget.id,
      status: 'browser_started',
      expiresAt: new Date(Date.now() + 600_000),
      stateHash: digest(state),
      browserBindingHash: digest(binding)
    }
    const providerEntered = Promise.withResolvers()
    const finishVerification = Promise.withResolvers()
    const databaseEntered = Promise.withResolvers()
    const releaseDatabase = Promise.withResolvers()
    let claim
    let signal
    let providerCalls = 0
    let transactions = 0
    let completed = false
    const manager = {
      query: async () => [{ now: new Date() }],
      getRepository: () => ({
        findOne: async () => ({ ...stored }),
        update: async (_where, patch) => Object.assign(stored, patch)
      })
    }
    const deps = {
      registry: { resolve: () => snapshot },
      pkceKeys: { decrypt: () => verifier },
      dataSource: {
        transaction: async (_isolation, operation) => {
          const isSecondTransaction = ++transactions === 2
          if (isSecondTransaction) {
            databaseEntered.resolve()
            await releaseDatabase.promise
          }
          const result = await operation(manager)
          const isClaimedResult = result?.status === 'claimed'
          if (isClaimedResult) {
            claim = result.claim
          }
          return result
        }
      },
      verifyProvider: async (input) => {
        providerCalls++
        assert.equal(input.code, 'fixture-provider-code')
        assert.equal(input.providerVerifier, verifier)
        signal = input.signal
        providerEntered.resolve()
        await finishVerification.promise
        const isRejectionOutcome = outcome === 'rejection'
        if (isRejectionOutcome) {
          throw new Error('fixture provider failure')
        }
        const isInvalidIdentityOutcome = outcome === 'invalid identity'
        return {
          provider: 'google',
          subject: isInvalidIdentityOutcome ? '' : 'fixture-subject'
        }
      }
    }
    const pending = settled(
      completeLoginCallback(
        deps,
        'google',
        new URLSearchParams({ state, code: 'fixture-provider-code' }),
        `__Host-ldb-login-${stored.id}=${binding}`
      )
    ).then((result) => {
      completed = true
      return result
    })

    try {
      await bounded(providerEntered.promise)
      assert.equal(claim.providerCode, 'fixture-provider-code')
      assert.equal(claim.providerVerifier, verifier)
      if (isTimeoutOutcome) {
        t.mock.timers.tick(LOGIN.providerDeadlineMs)
      } else {
        finishVerification.resolve()
      }

      // 성공 저장/실패 정리 transaction이 대기 중이어도 proof 참조는 이미 해제돼야 한다.
      await bounded(databaseEntered.promise)
      assert.equal(completed, false)
      assert.equal(signal.aborted, true)
      assert.equal(claim.providerVerifier, '')
      assert.equal(claim.providerCode, '')
      assert.equal(providerCalls, 1)
    } finally {
      finishVerification.resolve()
      releaseDatabase.resolve()
      await pending
    }

    const result = await pending
    const isSuccessOutcome = outcome === 'success'
    assert.equal(result.error?.code, isSuccessOutcome ? undefined : 'AUTH_PROVIDER_ERROR')
    assert.equal(stored.status, isSuccessOutcome ? 'exchange_ready' : 'failed')
  })
}

test('expired processing callback read commits terminal cleanup after an uncertain prior claim', async () => {
  const state = opaque(),
    binding = opaque(),
    time = new Date('2026-09-06T00:10:00Z')
  const stored = {
    id: randomUUID(),
    provider: 'google',
    status: 'processing',
    expiresAt: time,
    stateHash: digest(state),
    browserBindingHash: digest(binding)
  }
  let updates = 0,
    providerCalls = 0
  const manager = {
    query: async () => [{ now: time }],
    getRepository: () => ({
      findOne: async () => stored,
      update: async (_where, patch) => {
        updates++
        Object.assign(stored, patch)
      }
    })
  }
  const deps = {
    dataSource: { transaction: async (_isolation, operation) => operation(manager) },
    verifyProvider: async () => {
      providerCalls++
    }
  }
  await assert.rejects(
    () =>
      completeLoginCallback(
        deps,
        'google',
        new URLSearchParams({ state, code: 'fixture-provider-code' }),
        `__Host-ldb-login-${stored.id}=${binding}`
      ),
    { code: 'LOGIN_REQUEST_INVALID' }
  )
  assert.equal(providerCalls, 0)
  assert.equal(updates, 1)
  assert.equal(stored.status, 'failed')
  assert.equal(stored.stateHash, null)
})

test('expired active request read by exchange clears secrets while terminal consumed state is preserved', async () => {
  for (const status of ['created', 'processing', 'consumed']) {
    const time = new Date('2026-09-06T00:10:00Z')
    const stored = { id: randomUUID(), status, expiresAt: time, clientId: 'desktop' }
    let updates = 0
    const manager = {
      query: async () => [{ now: time }],
      getRepository: () => ({
        findOne: async () => stored,
        update: async (_where, patch) => {
          updates++
          Object.assign(stored, patch)
        }
      })
    }
    await assert.rejects(
      () =>
        exchangeLogin(
          { dataSource: { transaction: async (_isolation, operation) => operation(manager) } },
          { requestId: stored.id, clientId: 'desktop', code: opaque(), codeVerifier: opaque() }
        ),
      { code: 'LOGIN_EXCHANGE_INVALID' }
    )
    const isConsumedStatus = status === 'consumed'
    assert.equal(updates, isConsumedStatus ? 0 : 1)
    assert.equal(stored.status, isConsumedStatus ? 'consumed' : 'failed')
  }
})

test('failed exchange row rejects without mutation', async () => {
  const stored = { id: randomUUID(), status: 'failed', expiresAt: new Date(Date.now() + 600_000) }
  let updates = 0
  const manager = {
    query: async () => [{ now: new Date() }],
    getRepository: () => ({
      findOne: async () => stored,
      update: async () => {
        updates++
      }
    })
  }
  await assert.rejects(
    () =>
      exchangeLogin(
        { dataSource: { transaction: async (_isolation, operation) => operation(manager) } },
        { requestId: stored.id, clientId: 'desktop', code: opaque(), codeVerifier: opaque() }
      ),
    { code: 'LOGIN_EXCHANGE_INVALID' }
  )
  assert.equal(updates, 0)
})

test('consumed exchange row reads status once before rejecting', async () => {
  let statusReads = 0
  const stored = {
    id: randomUUID(),
    get status() {
      statusReads++
      return 'consumed'
    },
    expiresAt: new Date(Date.now() + 600_000)
  }
  const manager = {
    query: async () => [{ now: new Date() }],
    getRepository: () => ({ findOne: async () => stored })
  }
  await assert.rejects(
    () =>
      exchangeLogin(
        { dataSource: { transaction: async (_isolation, operation) => operation(manager) } },
        { requestId: stored.id, clientId: 'desktop', code: opaque(), codeVerifier: opaque() }
      ),
    { code: 'LOGIN_EXCHANGE_INVALID' }
  )
  assert.equal(statusReads, 1)
})

test('Discord authorize omits nonce and persists a null nonce hash', async () => {
  const snapshot = registration()
  snapshot.provider = 'discord'
  snapshot.expectedAudience = null
  const stored = {
    id: randomUUID(),
    provider: 'discord',
    providerConfigVersion: snapshot.version,
    returnTargetId: snapshot.returnTarget.id,
    status: 'created',
    expiresAt: new Date(Date.now() + 600_000)
  }
  let patch
  const manager = {
    query: async () => [{ now: new Date() }],
    getRepository: () => ({
      findOne: async () => stored,
      update: async (_where, nextPatch) => {
        patch = nextPatch
      }
    })
  }
  const authorization = await authorizeLogin(
    {
      registry: { resolve: () => snapshot },
      pkceKeys: { encrypt: () => ({ provider_pkce_ciphertext: 'cipher' }) },
      dataSource: { transaction: async (_isolation, operation) => operation(manager) }
    },
    opaque()
  )
  assert.equal(new URL(authorization.redirectUrl).searchParams.has('nonce'), false)
  assert.equal(patch.oidcNonceHash, null)
})
