import { createHash, timingSafeEqual } from 'node:crypto'
import { jwtVerify } from 'jose'
import type { JWTPayload } from 'jose'
import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { LoginDependencies, ProviderRegistration, ProviderVerificationInput } from '../../types/login.js'
import { decodeOpaque, equalHash, opaqueHash } from '../login/crypto.js'
import { LoginRegistry } from '../login/registry.js'
import { createGoogleJwks } from './jwks.js'
import { exchangeGoogleCode, withAbort } from './transport.js'
import type { GoogleProviderConfiguration } from './types.js'

function trustedUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.href !== value || url.username || url.password ||
    url.search || url.hash || value.includes('*')) {
    throw new Error()
  }
  return url.href
}

function sameSnapshot(expected: ProviderRegistration, actual: ProviderRegistration): boolean {
  return expected.provider === actual.provider && expected.version === actual.version &&
    expected.providerClientId === actual.providerClientId &&
    expected.providerSecretRef === actual.providerSecretRef &&
    expected.callbackUrl === actual.callbackUrl &&
    expected.authorizationEndpoint === actual.authorizationEndpoint &&
    expected.expectedAudience === actual.expectedAudience &&
    expected.returnTarget.id === actual.returnTarget.id &&
    expected.returnTarget.url === actual.returnTarget.url
}

function verifyGoogleClaims(
  payload: JWTPayload,
  snapshot: ProviderRegistration,
  nonceHash: Buffer,
  accessToken: unknown,
): string {
  // jose의 audience 검사는 array도 수용하므로 Google의 단일 exact string을 추가 확인한다.
  if (payload.aud !== snapshot.expectedAudience) throw new Error()
  if (payload.azp !== undefined && payload.azp !== snapshot.expectedAudience) throw new Error()

  const checkedAt = Math.floor(Date.now() / 1000)
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > checkedAt) {
    throw new Error()
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || checkedAt >= payload.exp) {
    throw new Error()
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255 ||
    [...payload.sub].some((character) => character.charCodeAt(0) > 127)) {
    throw new Error()
  }

  // 기존 생성·저장 함수와 동일한 canonical 32-byte decode/hash를 재사용한다.
  if (typeof payload.nonce !== 'string' || !equalHash(nonceHash, opaqueHash(payload.nonce))) {
    throw new Error()
  }
  if (payload.at_hash !== undefined) {
    if (typeof payload.at_hash !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(payload.at_hash) ||
      typeof accessToken !== 'string' || accessToken.length === 0 ||
      [...accessToken].some((character) => character.charCodeAt(0) > 127)) {
      throw new Error()
    }
    const claimedHash = Buffer.from(payload.at_hash, 'base64url')
    const expectedHash = createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16)
    if (claimedHash.length !== 16 || claimedHash.toString('base64url') !== payload.at_hash ||
      !timingSafeEqual(claimedHash, expectedHash)) {
      throw new Error()
    }
  }
  return payload.sub
}

/** 실제 값의 저장 정책을 정하지 않는 server-only composition 경계다. Listen 전에 생성한다. */
export function createGoogleProviderVerifier(
  configuration: GoogleProviderConfiguration,
): LoginDependencies['verifyProvider'] {
  try {
    const fetchGoogle = configuration.fetch ?? globalThis.fetch
    const resolveSecret = configuration.resolveSecret
    if (typeof fetchGoogle !== 'function' || typeof resolveSecret !== 'function') throw new Error()

    const registrations = new Map<string, {
      snapshot: ProviderRegistration
      tokenEndpoint: string
      jwksUri: string
      resolveKey: ReturnType<typeof createGoogleJwks>
    }>()
    for (const configured of configuration.registrations) {
      // 공통 registry의 등록 검증·복제·불변 snapshot 규칙을 그대로 쓴다.
      const registry = new LoginRegistry({
        apiOrigin: new URL(configured.snapshot.callbackUrl).origin,
        activeVersions: { google: configured.snapshot.version },
        registrations: [configured.snapshot],
      })
      const snapshot = registry.active('google')
      const tokenEndpoint = trustedUrl(configured.tokenEndpoint)
      const jwksUri = trustedUrl(configured.jwksUri)
      if (registrations.has(snapshot.version)) throw new Error()
      registrations.set(snapshot.version, {
        snapshot, tokenEndpoint, jwksUri, resolveKey: createGoogleJwks(jwksUri, fetchGoogle),
      })
    }
    if (registrations.size === 0) throw new Error()

    return async (input: ProviderVerificationInput | undefined) => {
      let exchange: Promise<unknown> | undefined
      let response: unknown
      let idToken: string | undefined
      let accessToken: unknown
      let payload: JWTPayload | undefined
      try {
        if (!input) throw new Error()
        const signal = input.signal
        signal.throwIfAborted()
        const registration = registrations.get(input.snapshot.version)
        if (!registration || !sameSnapshot(registration.snapshot, input.snapshot)) throw new Error()
        if (!Buffer.isBuffer(input.nonceHash) || input.nonceHash.length !== 32) throw new Error()
        const nonceHash = Buffer.from(input.nonceHash)
        if (typeof input.code !== 'string' || input.code.length === 0) throw new Error()
        decodeOpaque(input.providerVerifier)

        // Token 교환에는 저장 snapshot만 사용하고 active registry를 조회하지 않는다.
        exchange = exchangeGoogleCode(registration, input, resolveSecret, fetchGoogle)
        input = undefined
        response = await exchange
        exchange = undefined
        if (!response || typeof response !== 'object' || !('id_token' in response) ||
          typeof response.id_token !== 'string' || response.id_token.length === 0) {
          throw new Error()
        }
        idToken = response.id_token
        accessToken = 'access_token' in response ? response.access_token : undefined
        response = undefined

        // 자체 ES256 JWT issuer/key/type와 공유하지 않는 Google RS256 신뢰 경계다.
        const verified = await withAbort(jwtVerify(idToken,
          (header, token) => registration.resolveKey(header, token, signal), {
            algorithms: ['RS256'],
            issuer: ['https://accounts.google.com', 'accounts.google.com'],
            audience: registration.snapshot.providerClientId,
            requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce'],
            clockTolerance: 0,
          }), signal)
        payload = verified.payload
        signal.throwIfAborted()
        const subject = verifyGoogleClaims(payload, registration.snapshot, nonceHash, accessToken)
        signal.throwIfAborted()
        return { provider: 'google', subject }
      } catch {
        throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
      } finally {
        // JS string zeroization/GC 시점을 보장하지 않으며 후속 DB 대기 전 소유 참조를 해제한다.
        input = undefined
        exchange = undefined
        response = undefined
        idToken = undefined
        accessToken = undefined
        payload = undefined
      }
    }
  } catch {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
}
