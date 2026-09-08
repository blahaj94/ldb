import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { URL, URLSearchParams } from 'node:url'
import { creation, opaque, registryConfiguration } from './login-fixtures.mjs'

export const digest = (value) =>
  createHash('sha256').update(Buffer.from(value, 'base64url')).digest()
export const proof = (value) => createHash('sha256').update(value, 'ascii').digest('base64url')

export async function counts(source) {
  const rows = await source.query(`SELECT
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM auth_sessions) AS sessions,
    (SELECT count(*)::int FROM auth_refresh_tokens) AS refresh`)
  return rows[0]
}

export async function row(source, id) {
  return (await source.query('SELECT * FROM auth_login_requests WHERE id=$1', [id]))[0]
}

export function assertCleared(request, status) {
  assert.equal(request.status, status)
  for (const field of [
    'code_challenge',
    'method',
    'launch_ticket_hash',
    'state_hash',
    'browser_binding_hash',
    'oidc_nonce_hash',
    'provider_pkce_ciphertext',
    'provider_pkce_iv',
    'provider_pkce_tag',
    'provider_pkce_key_id',
    'verified_subject',
    'exchange_code_hash',
    'code_expires_at'
  ]) {
    assert.equal(request[field], null, field)
  }
  assert.equal(request.consumed_at instanceof Date, status === 'consumed')
}

export async function failure(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code)
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(
      String(error.stack),
      /fixture-secret|fixture-subject|fixture-provider-code|SQL detail/
    )
    return true
  })
}

export async function fixture(source, overrides = {}) {
  const { createLoginService } = await import('../dist/auth/login/service.js')
  const { LoginRegistry } = await import('../dist/auth/login/registry.js')
  const { ProviderPkceKeys } = await import('../dist/auth/login/crypto.js')
  const { createAccessJwtIssuer, createAccessJwtVerifier } =
    await import('../dist/auth/access-jwt/index.js')
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const signing = {
    issuer: 'https://issuer.test.invalid',
    audience: 'test-api',
    verificationKeys: [
      { kid: 'test-key', publicKeyPem: keyPair.publicKey.export({ format: 'pem', type: 'spki' }) }
    ],
    signingKey: {
      kid: 'test-key',
      privateKeyPem: keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' })
    }
  }
  const issueAccessJwt = await createAccessJwtIssuer(signing)
  const verifyJwt = await createAccessJwtVerifier(signing)
  const subject = randomUUID()
  const verifiedCalls = []
  const dependencies = {
    dataSource: source,
    registry: new LoginRegistry(registryConfiguration()),
    pkceKeys: new ProviderPkceKeys({
      activeKeyId: 'test-pkce',
      keys: [{ id: 'test-pkce', key: randomBytes(32) }]
    }),
    issueAccessJwt,
    verifyProvider: async (input) => {
      verifiedCalls.push(input)
      assert.equal(input.code, 'fixture-provider-code')
      assert.equal(input.signal.aborted, false)
      return { provider: input.snapshot.provider, subject }
    },
    ...overrides
  }
  const service = createLoginService(dependencies)
  return { service, dependencies, issueAccessJwt, verifyJwt, verifiedCalls, subject }
}

export async function started(service, provider = 'google') {
  const verifier = opaque()
  const request = await service.create(creation(proof(verifier), provider))
  const ticket = new URL(request.browserUrl).searchParams.get('ticket')
  const browser = await service.authorize(ticket)
  const authorization = new URL(browser.redirectUrl)
  const state = authorization.searchParams.get('state')
  const cookie = browser.cookie.split(';')[0]
  return { request, verifier, ticket, browser, authorization, state, cookie, provider }
}

export async function ready(service, provider = 'google') {
  const flow = await started(service, provider)
  const completion = await service.callback(
    provider,
    new URLSearchParams({ state: flow.state, code: 'fixture-provider-code', scope: 'ignored' }),
    flow.cookie
  )
  const code = new URL(completion.returnUrl).searchParams.get('code')
  return {
    ...flow,
    completion,
    code,
    exchange: {
      requestId: flow.request.requestId,
      clientId: 'desktop',
      code,
      codeVerifier: flow.verifier
    }
  }
}

export async function assertCommonLogin(source, mark = () => undefined) {
  const before = await source.query('SELECT * FROM auth_sessions ORDER BY id')
  const f = await fixture(source)
  mark('request and browser have no member writes')
  const baseline = await counts(source)
  const verifier = opaque()
  const request = await f.service.create(creation(proof(verifier)))
  const created = await row(source, request.requestId)
  assert.equal(created.status, 'created')
  assert.equal(created.expires_at - created.created_at, 600_000)
  assert.equal(created.created_at.getTime() % 1000, 0)
  const ticket = new URL(request.browserUrl).searchParams.get('ticket')
  assert.deepEqual(created.launch_ticket_hash, digest(ticket))
  assert.equal(created.verified_subject, null)
  assert.deepEqual(await counts(source), baseline)
  const browser = await f.service.authorize(ticket)
  const authorization = new URL(browser.redirectUrl)
  const state = authorization.searchParams.get('state')
  const cookie = browser.cookie.split(';')[0]
  const launched = await row(source, request.requestId)
  assert.equal(launched.status, 'browser_started')
  assert.equal(launched.launch_ticket_hash, null)
  assert.deepEqual(launched.state_hash, digest(state))
  assert.deepEqual(launched.oidc_nonce_hash, digest(authorization.searchParams.get('nonce')))
  assert.notEqual(authorization.searchParams.get('code_challenge'), proof(verifier))
  assert.equal(authorization.searchParams.get('scope'), 'openid profile')
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(
    authorization.searchParams.get('redirect_uri'),
    'https://api.test.invalid/auth/callback/google'
  )
  assert.match(browser.cookie, new RegExp(`^__Host-ldb-login-${request.requestId}=`))
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) {
    assert(browser.cookie.includes(flag))
  }
  assert.doesNotMatch(browser.cookie, /Domain=/i)
  assert(Number(/Max-Age=(\d+)/.exec(browser.cookie)[1]) <= 600)
  await failure(() => f.service.authorize(ticket), 'LOGIN_REQUEST_INVALID')
  assert.deepEqual(await counts(source), baseline)

  mark('callback binding, verified result and exchange-ready')
  const params = new URLSearchParams({ state, code: 'fixture-provider-code' })
  await failure(() => f.service.callback('discord', params, cookie), 'LOGIN_REQUEST_INVALID')
  await failure(
    () => f.service.callback('google', params, '__Host-other=wrong'),
    'LOGIN_REQUEST_INVALID'
  )
  await failure(
    () => f.service.callback('google', params, `${cookie}; ${cookie}`),
    'LOGIN_REQUEST_INVALID'
  )
  assert.equal(f.verifiedCalls.length, 0)
  assert.deepEqual(await row(source, request.requestId), launched)
  const completion = await f.service.callback('google', params, cookie)
  assert.equal(f.verifiedCalls.length, 1)
  assert.equal(
    proof(f.verifiedCalls[0].providerVerifier),
    authorization.searchParams.get('code_challenge')
  )
  assert.deepEqual(f.verifiedCalls[0].nonceHash, launched.oidc_nonce_hash)
  const code = new URL(completion.returnUrl).searchParams.get('code')
  const exchangeReady = await row(source, request.requestId)
  assert.equal(exchangeReady.status, 'exchange_ready')
  assert.deepEqual(exchangeReady.exchange_code_hash, digest(code))
  assert.equal(exchangeReady.verified_subject, f.subject)
  assert(exchangeReady.code_expires_at <= exchangeReady.expires_at)
  assert(exchangeReady.code_expires_at - Date.now() <= 60_000)
  assert.deepEqual(await counts(source), baseline)
  await failure(() => f.service.callback('google', params, cookie), 'LOGIN_REQUEST_INVALID')

  mark('actual exchange validates proof and atomically commits tokens')
  const exchange = {
    requestId: request.requestId,
    clientId: 'desktop',
    code,
    codeVerifier: verifier
  }
  await failure(
    () => f.service.exchange({ ...exchange, codeVerifier: opaque() }),
    'LOGIN_EXCHANGE_INVALID'
  )
  await failure(() => f.service.exchange({ ...exchange, code: opaque() }), 'LOGIN_EXCHANGE_INVALID')
  await failure(
    () => f.service.exchange({ ...exchange, requestId: randomUUID() }),
    'LOGIN_EXCHANGE_INVALID'
  )
  assert.deepEqual(await row(source, request.requestId), exchangeReady)
  assert.deepEqual(await counts(source), baseline)
  const result = await f.service.exchange(exchange)
  assert.equal(result.tokenType, 'Bearer')
  assert.equal(result.isNewUser, true)
  assert.deepEqual(Object.keys(result.user).sort(), ['id', 'nickname'])
  const principal = await f.verifyJwt(result.accessToken, Math.floor(Date.now() / 1000))
  assert.equal(principal.userId, result.user.id)
  const [session] = await source.query('SELECT * FROM auth_sessions WHERE id=$1', [
    principal.sessionId
  ])
  const [refresh] = await source.query('SELECT * FROM auth_refresh_tokens WHERE session_id=$1', [
    session.id
  ])
  assert.deepEqual(refresh.token_hash, digest(result.refreshToken))
  assert.equal(session.last_active_at.getTime(), principal.issuedAt * 1000)
  assert.equal(new Date(result.sessionExpiresAt) - session.last_active_at, 2_592_000_000)
  assert.equal(new Date(result.accessTokenExpiresAt).getTime(), principal.expiresAt * 1000)
  assertCleared(await row(source, request.requestId), 'consumed')
  await failure(() => f.service.exchange(exchange), 'LOGIN_EXCHANGE_INVALID')
  assert.deepEqual(await counts(source), {
    users: baseline.users + 1,
    sessions: baseline.sessions + 1,
    refresh: baseline.refresh + 1
  })

  mark('existing identity preserves nickname and other sessions')
  await source.query('UPDATE users SET nickname=$2 WHERE id=$1', [result.user.id, '기존 닉네임 👩‍💻'])
  const secondFlow = await ready(f.service)
  const second = await f.service.exchange(secondFlow.exchange)
  assert.equal(second.user.id, result.user.id)
  assert.equal(second.user.nickname, '기존 닉네임 👩‍💻')
  assert.equal(second.isNewUser, false)
  assert.notEqual(second.refreshToken, result.refreshToken)
  const after = await source.query('SELECT * FROM auth_sessions ORDER BY id')
  assert.deepEqual(
    after.filter((item) => before.some((old) => old.id === item.id)),
    before
  )

  mark('sign failure rolls back actual code consumption and all identity writes')
  const broken = await fixture(source, {
    issueAccessJwt: async () => {
      throw new Error('fixture-secret SQL detail')
    }
  })
  const brokenFlow = await ready(broken.service)
  const beforeFailure = await counts(source)
  const beforeRequest = await row(source, brokenFlow.request.requestId)
  await failure(() => broken.service.exchange(brokenFlow.exchange), 'AUTH_INTERNAL_ERROR')
  assert.deepEqual(await counts(source), beforeFailure)
  assert.deepEqual(await row(source, brokenFlow.request.requestId), beforeRequest)

  mark('cancel and provider error clear terminal fields')
  const cancelled = await started(f.service)
  await failure(
    () =>
      f.service.callback(
        'google',
        new URLSearchParams({ state: cancelled.state, error: 'access_denied' }),
        cancelled.cookie
      ),
    'LOGIN_CANCELLED'
  )
  assertCleared(await row(source, cancelled.request.requestId), 'failed')
  const providerFailure = await fixture(source, {
    verifyProvider: async () => {
      throw new Error('fixture-secret')
    }
  })
  const failed = await started(providerFailure.service)
  await failure(
    () =>
      providerFailure.service.callback(
        'google',
        new URLSearchParams({ state: failed.state, code: 'fixture-provider-code' }),
        failed.cookie
      ),
    'AUTH_PROVIDER_ERROR'
  )
  assertCleared(await row(source, failed.request.requestId), 'failed')
  return { scenarios: 6 }
}
