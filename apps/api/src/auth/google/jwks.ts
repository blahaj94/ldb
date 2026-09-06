import { createLocalJWKSet, errors } from 'jose'
import type { JWK, JWSHeaderParameters, FlattenedJWSInput } from 'jose'
import { discardResponse, readProviderJson, withAbort } from './transport.js'

function cacheLifetime(headers: Headers): number {
  const directives = (headers.get('cache-control') ?? '').toLowerCase().split(',').map((part) => part.trim())
  if (directives.some((part) => /^(no-store|no-cache)(?:=|$)/.test(part))) return 0
  const maxAge = directives.find((part) => /^max-age=\d+$/.test(part))?.slice(8)
  const age = headers.get('age') ?? '0'
  if (!maxAge || !/^\d+$/.test(age)) return 0
  const remaining = Number(maxAge) - Number(age)
  return Number.isSafeInteger(remaining) && remaining > 0 ? remaining * 1000 : 0
}

/** Cache에는 public RSA JWK와 jose resolver만 둔다. Callback token/identity는 보유하지 않는다. */
export function createGoogleJwks(jwksUri: string, fetchGoogle: typeof globalThis.fetch) {
  let cached: { resolver: ReturnType<typeof createLocalJWKSet>; expiresAt: number } | undefined
  let lastStarted = 0
  let lastStored = 0

  async function load(signal: AbortSignal) {
    signal.throwIfAborted()
    const sequence = ++lastStarted
    let response: Response | undefined
    let body: unknown
    try {
      response = await withAbort(fetchGoogle(jwksUri, {
        method: 'GET', redirect: 'error', cache: 'no-store', signal,
      }), signal, discardResponse)
      // Body 대기를 cache 수명에 더하지 않는다.
      const expiresAt = Date.now() + cacheLifetime(response.headers)
      body = await readProviderJson(response, signal)
      signal.throwIfAborted()
      if (!body || typeof body !== 'object' || !('keys' in body) || !Array.isArray(body.keys)) {
        throw new Error()
      }
      const keys: JWK[] = body.keys.map((key: unknown) => {
        if (!key || typeof key !== 'object') throw new Error()
        // 검증/parsing은 jose에 맡기고 public RSA field 이외의 응답 data는 보관하지 않는다.
        const publicKey: Record<string, unknown> = {}
        for (const field of ['kty', 'kid', 'alg', 'use', 'key_ops', 'n', 'e']) {
          if (field in key) publicKey[field] = key[field as keyof typeof key]
        }
        return publicKey as JWK
      })
      const result = { resolver: createLocalJWKSet({ keys }), expiresAt }
      if (sequence >= lastStored) {
        lastStored = sequence
        cached = expiresAt > Date.now() ? result : undefined
      }
      return result
    } finally {
      if (response) discardResponse(response)
      body = undefined
      response = undefined
    }
  }

  return async (header: JWSHeaderParameters, token: FlattenedJWSInput, signal: AbortSignal) => {
    signal.throwIfAborted()
    const usedCache = cached !== undefined && Date.now() < cached.expiresAt
    const keys = usedCache && cached ? cached : await load(signal)
    try {
      return await withAbort(keys.resolver(header, token), signal)
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey)) throw error
      // Cold/expired 응답도 전파가 늦을 수 있으므로 unknown kid에만 한 번 새 key를 받는다.
      const refreshed = await load(signal)
      return withAbort(refreshed.resolver(header, token), signal)
    }
  }
}
