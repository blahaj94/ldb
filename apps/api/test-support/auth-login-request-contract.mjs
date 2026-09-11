import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { insertLogin, loginRequest, rejectConstraint } from './database-contract.mjs'

const states = ['created', 'browser_started', 'processing', 'exchange_ready', 'consumed', 'failed']
const providerPkce = [
  'provider_pkce_ciphertext',
  'provider_pkce_iv',
  'provider_pkce_tag',
  'provider_pkce_key_id'
]
const browserContext = ['state_hash', 'browser_binding_hash', 'oidc_nonce_hash']
const exchange = ['verified_subject', 'exchange_code_hash', 'code_expires_at']
const secretFields = [
  'code_challenge',
  'method',
  'launch_ticket_hash',
  ...browserContext,
  ...providerPkce,
  ...exchange
]
const required = {
  created: ['code_challenge', 'method', 'launch_ticket_hash'],
  browser_started: [
    'code_challenge',
    'method',
    'state_hash',
    'browser_binding_hash',
    'oidc_nonce_hash',
    ...providerPkce
  ],
  processing: [
    'code_challenge',
    'method',
    'state_hash',
    'browser_binding_hash',
    'oidc_nonce_hash',
    ...providerPkce
  ],
  exchange_ready: ['code_challenge', 'method', ...exchange],
  consumed: ['consumed_at'],
  failed: []
}
const forbidden = {
  created: [...browserContext, ...providerPkce, ...exchange, 'consumed_at'],
  browser_started: ['launch_ticket_hash', ...exchange, 'consumed_at'],
  processing: ['launch_ticket_hash', ...exchange, 'consumed_at'],
  exchange_ready: ['launch_ticket_hash', 'consumed_at'],
  consumed: secretFields,
  failed: [...secretFields, 'consumed_at']
}

function row({ status, overrides = {} }) {
  const request = loginRequest(status, randomUUID())
  for (const field of ['launch_ticket_hash', 'state_hash', 'exchange_code_hash']) {
    const isHashNonNull = request[field] !== null
    if (isHashNonNull) {
      request[field] = randomBytes(32)
    }
  }
  return { ...request, ...overrides }
}

async function accept({ dataSource, request }) {
  const runner = dataSource.createQueryRunner()
  await runner.connect()
  await runner.startTransaction()
  try {
    await insertLogin(runner, request)
    const [{ status }] = await runner.query(
      'SELECT status FROM auth_login_requests WHERE id = $1',
      [request.id]
    )
    assert.equal(status, request.status)
  } finally {
    await runner.rollbackTransaction()
    await runner.release()
  }
}

export async function assertLoginRequestStateMatrix(dataSource) {
  let accepted = 0
  let rejected = 0
  for (const status of states) {
    for (const provider of ['google', 'discord']) {
      await accept({ dataSource, request: row({ status, overrides: { provider } }) })
      accepted++
    }
    for (const field of required[status]) {
      const isProviderPkceField = providerPkce.includes(field)
      const isProcessing = status === 'processing'
      const shouldUsePkceConstraint = isProviderPkceField && isProcessing
      const constraint = shouldUsePkceConstraint ? 'pkce_fields' : `${status}_fields`
      await rejectConstraint(dataSource, `ck_auth_login_requests_${constraint}`, (runner) =>
        insertLogin(runner, row({ status, overrides: { [field]: null } }))
      )
      rejected++
    }
    for (const field of forbidden[status]) {
      const sample = { ...row({ status: 'browser_started' }), ...row({ status: 'exchange_ready' }) }
      // 각 nullable field를 하나씩 남겨 같은 실패 경계를 확인한다.
      const values = {
        ...sample,
        ...Object.fromEntries(
          providerPkce.map((key) => [key, row({ status: 'browser_started' })[key]])
        ),
        state_hash: randomBytes(32),
        browser_binding_hash: randomBytes(32),
        oidc_nonce_hash: randomBytes(32),
        launch_ticket_hash: randomBytes(32),
        consumed_at: new Date('2026-09-05T00:01:00Z')
      }
      const suffix = `${status}_fields`
      await rejectConstraint(dataSource, `ck_auth_login_requests_${suffix}`, (runner) =>
        insertLogin(runner, row({ status, overrides: { [field]: values[field] } }))
      )
      rejected++
    }
  }

  for (const status of ['browser_started', 'processing']) {
    // 현재 정책: Google nonce 필수, Discord는 NULL과 잔존 모두 허용한다.
    await accept({
      dataSource,
      request: row({ status, overrides: { provider: 'discord', oidc_nonce_hash: null } })
    })
    accepted++
  }
  // exchange_ready의 browser/provider proof 잔존은 기존 CHECK가 허용한다.
  const retained = row({ status: 'browser_started' })
  await accept({
    dataSource,
    request: row({
      status: 'exchange_ready',
      overrides: Object.fromEntries(
        [...browserContext, ...providerPkce].map((key) => [key, retained[key]])
      )
    })
  })
  accepted++

  for (const [field, suffix] of [
    ['launch_ticket_hash', 'launch_hash_length'],
    ['state_hash', 'state_hash_length'],
    ['browser_binding_hash', 'browser_hash_length'],
    ['oidc_nonce_hash', 'nonce_hash_length'],
    ['exchange_code_hash', 'exchange_hash_length']
  ]) {
    for (const length of [31, 33]) {
      await rejectConstraint(dataSource, `ck_auth_login_requests_${suffix}`, (runner) => {
        const isLaunchTicketHash = field === 'launch_ticket_hash'
        const status = isLaunchTicketHash ? 'created' : 'exchange_ready'
        return insertLogin(runner, row({ status, overrides: { [field]: Buffer.alloc(length) } }))
      })
      rejected++
    }
  }
  for (const [field, value] of [
    ['provider_pkce_ciphertext', Buffer.alloc(0)],
    ['provider_pkce_iv', Buffer.alloc(11)],
    ['provider_pkce_iv', Buffer.alloc(13)],
    ['provider_pkce_tag', Buffer.alloc(15)],
    ['provider_pkce_tag', Buffer.alloc(17)],
    ['provider_pkce_key_id', '']
  ]) {
    await rejectConstraint(dataSource, 'ck_auth_login_requests_pkce_fields', (runner) =>
      insertLogin(runner, row({ status: 'browser_started', overrides: { [field]: value } }))
    )
    rejected++
  }
  for (const [field, status, suffix] of [
    ['launch_ticket_hash', 'created', 'launch_ticket_hash'],
    ['state_hash', 'browser_started', 'state_hash'],
    ['exchange_code_hash', 'exchange_ready', 'exchange_code_hash']
  ]) {
    await rejectConstraint(dataSource, `uq_auth_login_requests_${suffix}`, async (runner) => {
      const first = row({ status })
      await insertLogin(runner, first)
      await insertLogin(runner, row({ status, overrides: { [field]: first[field] } }))
    })
    rejected++
  }
  return { accepted, rejected }
}
