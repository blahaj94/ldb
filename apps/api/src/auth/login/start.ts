import { randomUUID } from 'node:crypto'
import { AuthLoginRequestSchema } from '../../database/schemas/auth-login-requests.js'
import { CLEARED_LOGIN_FIELDS, LOGIN, LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { LoginDependencies } from '../../types/login.js'
import { challenge, decodeOpaque, newOpaque, opaqueHash } from './crypto.js'
import { parseCreation } from './input.js'
import { browserCookie, freshTime, loginTransaction, requestExpired, resolveRegistration, terminal } from './state.js'

export async function createLoginRequest(deps: LoginDependencies, input: unknown) {
  const body = parseCreation(input)
  const snapshot = deps.registry.active(body.provider)
  return loginTransaction(deps.dataSource, async (manager) => {
    const createdAt = await freshTime(manager)
    const expiresAt = new Date(createdAt.getTime() + LOGIN.requestSeconds * 1000)
    const ticket = newOpaque()
    let id: string
    try { id = randomUUID() } catch { throw new LoginFailure(LOGIN_ERRORS.INTERNAL) }
    await manager.getRepository(AuthLoginRequestSchema).insert({
      ...CLEARED_LOGIN_FIELDS, id, purpose: LOGIN.purpose, provider: body.provider, clientId: LOGIN.clientId,
      providerConfigVersion: snapshot.version, returnTargetId: snapshot.returnTarget.id,
      createdAt, expiresAt, status: 'created', codeChallenge: body.codeChallenge, method: LOGIN.method,
      launchTicketHash: opaqueHash(ticket), consumedAt: null,
    })
    return {
      requestId: id, browserUrl: `${deps.registry.apiOrigin}/auth/login/authorize?ticket=${ticket}`,
      expiresAt: expiresAt.toISOString(),
    }
  })
}

export async function authorizeLogin(deps: LoginDependencies, ticket: string) {
  try { decodeOpaque(ticket) } catch { throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID) }
  return loginTransaction(deps.dataSource, async (manager) => {
    const requests = manager.getRepository(AuthLoginRequestSchema)
    const row = await requests.findOne({ where: { launchTicketHash: opaqueHash(ticket) }, lock: { mode: 'pessimistic_write' } })
    const time = await freshTime(manager)
    if (!row || row.status !== 'created') throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
    if (requestExpired(row, time)) {
      await terminal(manager, row)
      return new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
    }
    const snapshot = await resolveRegistration(manager, row, deps.registry)
    if (snapshot instanceof LoginFailure) return snapshot
    const state = newOpaque(), binding = newOpaque(), providerVerifier = newOpaque()
    const nonce = row.provider === 'google' ? newOpaque() : null
    await requests.update({ id: row.id }, {
      status: 'browser_started', launchTicketHash: null,
      stateHash: opaqueHash(state), browserBindingHash: opaqueHash(binding), oidcNonceHash: nonce ? opaqueHash(nonce) : null,
      ...deps.pkceKeys.encrypt(providerVerifier, row),
    })
    const url = new URL(snapshot.authorizationEndpoint)
    url.search = new URLSearchParams({
      response_type: 'code', client_id: snapshot.providerClientId, redirect_uri: snapshot.callbackUrl,
      scope: row.provider === 'google' ? 'openid profile' : 'identify',
      state, code_challenge: challenge(providerVerifier), code_challenge_method: LOGIN.method,
      ...(nonce ? { nonce } : {}),
    }).toString()
    return {
      redirectUrl: url.href,
      cookie: browserCookie(row.id, binding, Math.min(LOGIN.requestSeconds, (row.expiresAt.getTime() - time.getTime()) / 1000)),
    }
  })
}
