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
  const endpointIsInvalid = url.protocol !== 'https:' || url.href !== value ||
    url.username || url.password || url.search || url.hash || value.includes('*')
  if (endpointIsInvalid) {
    throw new TypeError('Google provider endpoint must be an exact HTTPS URL')
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
  if (payload.aud !== snapshot.expectedAudience) {
    throw new Error('Google ID token audience does not match registration')
  }
  if (payload.azp !== undefined && payload.azp !== snapshot.expectedAudience) {
    throw new Error('Google ID token authorized party does not match registration')
  }

  const checkedAt = Math.floor(Date.now() / 1000)
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new TypeError('Google ID token issued time must be a finite number')
  }
  if (payload.iat > checkedAt) {
    throw new RangeError('Google ID token issued time is in the future')
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    throw new TypeError('Google ID token expiration must be a finite number')
  }
  if (checkedAt >= payload.exp) {
    throw new RangeError('Google ID token has expired')
  }
  if (typeof payload.sub !== 'string') {
    throw new TypeError('Google subject must be a string')
  }
  if (payload.sub.length === 0 || payload.sub.length > 255) {
    throw new RangeError('Google subject length is outside the accepted range')
  }
  if ([...payload.sub].some((character) => character.charCodeAt(0) > 127)) {
    throw new TypeError('Google subject must contain only ASCII characters')
  }

  // 기존 생성·저장 함수와 동일한 canonical 32-byte decode/hash를 재사용한다.
  if (typeof payload.nonce !== 'string') {
    throw new TypeError('Google nonce must be a string')
  }
  if (!equalHash(nonceHash, opaqueHash(payload.nonce))) {
    throw new Error('Google nonce does not match the login request')
  }
  if (payload.at_hash !== undefined) {
    const accessHash = payload.at_hash
    const accessHashIsMalformed = typeof accessHash !== 'string' ||
      !/^[A-Za-z0-9_-]{22}$/.test(accessHash)
    if (accessHashIsMalformed) {
      throw new TypeError('Google access-token hash must use canonical base64url')
    }
    const accessTokenIsInvalid = typeof accessToken !== 'string' || accessToken.length === 0 ||
      [...accessToken].some((character) => character.charCodeAt(0) > 127)
    if (accessTokenIsInvalid) {
      throw new TypeError('Google access token must be present as ASCII for at_hash')
    }
    const claimedHash = Buffer.from(accessHash, 'base64url')
    const expectedHash = createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16)
    if (claimedHash.length !== 16 || claimedHash.toString('base64url') !== accessHash) {
      throw new TypeError('Google access-token hash encoding is not canonical')
    }
    if (!timingSafeEqual(claimedHash, expectedHash)) {
      throw new Error('Google access-token hash does not match the access token')
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
    if (typeof fetchGoogle !== 'function' || typeof resolveSecret !== 'function') {
      throw new TypeError('Google provider dependencies must be callable')
    }

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
      if (registrations.has(snapshot.version)) {
        throw new TypeError('Google provider registration version is duplicated')
      }
      registrations.set(snapshot.version, {
        snapshot, tokenEndpoint, jwksUri, resolveKey: createGoogleJwks(jwksUri, fetchGoogle),
      })
    }
    if (registrations.size === 0) {
      throw new RangeError('Google provider registration list must not be empty')
    }

    return async (input: ProviderVerificationInput | undefined) => {
      let exchange: Promise<unknown> | undefined
      let response: unknown
      let idToken: string | undefined
      let accessToken: unknown
      let payload: JWTPayload | undefined
      try {
        if (!input) throw new TypeError('Google provider verification input is required')
        const signal = input.signal
        signal.throwIfAborted()
        const registration = registrations.get(input.snapshot.version)
        if (!registration || !sameSnapshot(registration.snapshot, input.snapshot)) {
          throw new Error('Google provider registration snapshot does not match')
        }
        if (!Buffer.isBuffer(input.nonceHash) || input.nonceHash.length !== 32) {
          throw new TypeError('Google nonce digest must contain 32 bytes')
        }
        const nonceHash = Buffer.from(input.nonceHash)
        if (typeof input.code !== 'string' || input.code.length === 0) {
          throw new TypeError('Google authorization code is missing')
        }
        decodeOpaque(input.providerVerifier)

        // Token 교환에는 저장 snapshot만 사용하고 active registry를 조회하지 않는다.
        exchange = exchangeGoogleCode(registration, input, resolveSecret, fetchGoogle)
        input = undefined
        response = await exchange
        exchange = undefined
        {
          // 검증용 const가 block 밖의 JWKS 대기까지 원문 응답을 보유하지 않게 한다.
          const tokenResponse = response
          const responseIsNotObject = tokenResponse === null || typeof tokenResponse !== 'object'
          if (responseIsNotObject) {
            throw new TypeError('Google token response must be an object')
          }
          const candidateIdToken = 'id_token' in tokenResponse ? tokenResponse.id_token : undefined
          const idTokenIsMissing = typeof candidateIdToken !== 'string' || candidateIdToken.length === 0
          if (idTokenIsMissing) {
            throw new TypeError('Google token response must contain an ID token')
          }
          idToken = candidateIdToken
          accessToken = 'access_token' in tokenResponse ? tokenResponse.access_token : undefined
        }
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
