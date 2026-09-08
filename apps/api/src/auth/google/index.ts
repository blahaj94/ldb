import { createHash, timingSafeEqual } from 'node:crypto'
import { jwtVerify } from 'jose'
import type { JWTPayload } from 'jose'
import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure, loginFailure } from '../../errors/login.js'
import type {
  LoginDependencies,
  ProviderRegistration,
  ProviderVerificationInput
} from '../../types/login.js'
import { decodeOpaque, equalHash, opaqueHash } from '../login/crypto.js'
import { LoginRegistry } from '../login/registry.js'
import { createGoogleJwks } from './jwks.js'
import { exchangeGoogleCode, withAbort } from './transport.js'
import type { GoogleProviderConfiguration } from './types.js'

interface RegisteredGoogleProvider {
  snapshot: ProviderRegistration
  tokenEndpoint: string
  jwksUri: string
  resolveKey: ReturnType<typeof createGoogleJwks>
}

function trustedUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  const isHttps = url.protocol === 'https:'
  const isExactUrl = url.href === value
  const hasUsername = url.username.length > 0
  const hasPassword = url.password.length > 0
  const hasQuery = url.search.length > 0
  const hasFragment = url.hash.length > 0
  const hasWildcard = value.includes('*')
  const isTrustedUrlShape =
    isHttps &&
    isExactUrl &&
    !hasUsername &&
    !hasPassword &&
    !hasQuery &&
    !hasFragment &&
    !hasWildcard
  if (!isTrustedUrlShape) {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
  return url.href
}

function sameSnapshot(expected: ProviderRegistration, actual: ProviderRegistration): boolean {
  // 첫 불일치 뒤 property를 읽지 않도록 기존 short-circuit 순서도 유지한다.
  const hasSameProvider = expected.provider === actual.provider
  const hasSameVersion = hasSameProvider && expected.version === actual.version
  const hasSameClientId = hasSameVersion && expected.providerClientId === actual.providerClientId
  const hasSameSecretReference =
    hasSameClientId && expected.providerSecretRef === actual.providerSecretRef
  const hasSameCallback = hasSameSecretReference && expected.callbackUrl === actual.callbackUrl
  const hasSameAuthorizationEndpoint =
    hasSameCallback && expected.authorizationEndpoint === actual.authorizationEndpoint
  const hasSameAudience =
    hasSameAuthorizationEndpoint && expected.expectedAudience === actual.expectedAudience
  const hasSameReturnTargetId =
    hasSameAudience && expected.returnTarget.id === actual.returnTarget.id
  const hasSameReturnUrl =
    hasSameReturnTargetId && expected.returnTarget.url === actual.returnTarget.url
  const isSameSnapshot =
    hasSameProvider &&
    hasSameVersion &&
    hasSameClientId &&
    hasSameSecretReference &&
    hasSameCallback &&
    hasSameAuthorizationEndpoint &&
    hasSameAudience &&
    hasSameReturnTargetId &&
    hasSameReturnUrl
  return isSameSnapshot
}

function verifyGoogleClaims(
  payload: JWTPayload,
  snapshot: ProviderRegistration,
  nonceHash: Buffer,
  accessToken: unknown
): string {
  // jose의 audience 검사는 array도 수용하므로 Google의 단일 exact string을 추가 확인한다.
  const hasExpectedAudience = payload.aud === snapshot.expectedAudience
  if (!hasExpectedAudience) {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  }
  const hasAuthorizedParty = payload.azp !== undefined
  const hasWrongAuthorizedParty = hasAuthorizedParty && payload.azp !== snapshot.expectedAudience
  if (hasWrongAuthorizedParty) {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  }

  const checkedAt = Math.floor(Date.now() / 1000)
  const issuedAt = payload.iat
  const isIssuedAtNumber = typeof issuedAt === 'number'
  const isIssuedAtFinite = isIssuedAtNumber && Number.isFinite(issuedAt)
  const isValidIssuedAt = isIssuedAtNumber && isIssuedAtFinite
  if (!isValidIssuedAt) {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  }
  const isIssuedInFuture = issuedAt > checkedAt
  if (isIssuedInFuture) {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  }
  const expiresAt = payload.exp
  const isExpiryNumber = typeof expiresAt === 'number'
  const isExpiryFinite = isExpiryNumber && Number.isFinite(expiresAt)
  const isValidExpiry = isExpiryNumber && isExpiryFinite
  if (!isValidExpiry) {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  }
  const isExpired = checkedAt >= expiresAt
  if (isExpired) {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  }
  const subject = payload.sub
  const isSubjectString = typeof subject === 'string'
  if (!isSubjectString) {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  }
  const hasSubject = subject.length > 0
  const isSubjectWithinLimit = subject.length <= 255
  const isValidSubjectLength = hasSubject && isSubjectWithinLimit
  if (!isValidSubjectLength) {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  }
  const hasNonAsciiSubject = [...subject].some((character) => {
    const isNonAscii = character.charCodeAt(0) > 127
    return isNonAscii
  })
  if (hasNonAsciiSubject) {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  }

  // 기존 생성·저장 함수와 동일한 canonical 32-byte decode/hash를 재사용한다.
  const nonce = payload.nonce
  const isNonceString = typeof nonce === 'string'
  if (!isNonceString) {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  }
  let candidateNonceHash: Buffer
  try {
    // 공통 opaque parser의 형식 오류를 provider 응답 검증의 정제 오류로 변환한다.
    candidateNonceHash = opaqueHash(nonce)
  } catch {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  }
  const hasExpectedNonce = equalHash(nonceHash, candidateNonceHash)
  if (!hasExpectedNonce) {
    throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
  }
  const hasAccessHash = payload.at_hash !== undefined
  if (hasAccessHash) {
    const accessHash = payload.at_hash
    const isAccessHashString = typeof accessHash === 'string'
    const hasAccessHashEncoding = isAccessHashString && /^[A-Za-z0-9_-]{22}$/.test(accessHash)
    const isValidAccessHashShape = isAccessHashString && hasAccessHashEncoding
    if (!isValidAccessHashShape) {
      throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
    }
    const isAccessTokenString = typeof accessToken === 'string'
    const hasAccessToken = isAccessTokenString && accessToken.length > 0
    const hasNonAsciiAccessToken =
      hasAccessToken &&
      [...accessToken].some((character) => {
        const isNonAscii = character.charCodeAt(0) > 127
        return isNonAscii
      })
    const isValidAccessToken = isAccessTokenString && hasAccessToken && !hasNonAsciiAccessToken
    if (!isValidAccessToken) {
      throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
    }
    const claimedHash = Buffer.from(accessHash, 'base64url')
    const expectedHash = createHash('sha256').update(accessToken, 'ascii').digest().subarray(0, 16)
    const hasHashBytes = claimedHash.length === 16
    const isCanonicalHash = hasHashBytes && claimedHash.toString('base64url') === accessHash
    const isValidHashEncoding = hasHashBytes && isCanonicalHash
    if (!isValidHashEncoding) {
      throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
    }
    const hasExpectedAccessHash = timingSafeEqual(claimedHash, expectedHash)
    if (!hasExpectedAccessHash) {
      throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
    }
  }
  return subject
}

/** 실제 값의 저장 정책을 정하지 않는 server-only composition 경계다. Listen 전에 생성한다. */
export function createGoogleProviderVerifier(
  configuration: GoogleProviderConfiguration
): LoginDependencies['verifyProvider'] {
  try {
    const configuredFetch = configuration.fetch
    const hasConfiguredFetch = configuredFetch != null
    const fetchGoogle = hasConfiguredFetch ? configuredFetch : globalThis.fetch
    const resolveSecret = configuration.resolveSecret
    const canFetch = typeof fetchGoogle === 'function'
    const canResolveSecret = typeof resolveSecret === 'function'
    const hasProviderDependencies = canFetch && canResolveSecret
    if (!hasProviderDependencies) {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }

    const registrations = new Map<string, RegisteredGoogleProvider>()
    for (const configured of configuration.registrations) {
      // 공통 registry의 등록 검증·복제·불변 snapshot 규칙을 그대로 쓴다.
      const registry = new LoginRegistry({
        apiOrigin: new URL(configured.snapshot.callbackUrl).origin,
        activeVersions: { google: configured.snapshot.version },
        registrations: [configured.snapshot]
      })
      const snapshot = registry.active('google')
      const tokenEndpoint = trustedUrl(configured.tokenEndpoint)
      const jwksUri = trustedUrl(configured.jwksUri)
      const isDuplicateVersion = registrations.has(snapshot.version)
      if (isDuplicateVersion) {
        throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
      }
      registrations.set(snapshot.version, {
        snapshot,
        tokenEndpoint,
        jwksUri,
        resolveKey: createGoogleJwks(jwksUri, fetchGoogle)
      })
    }
    const hasRegistrations = registrations.size > 0
    if (!hasRegistrations) {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }

    return async (input: ProviderVerificationInput | undefined) => {
      let exchange: Promise<unknown> | undefined
      let response: unknown
      let idToken: string | undefined
      let accessToken: unknown
      let payload: JWTPayload | undefined
      try {
        let signal: AbortSignal
        let registration: RegisteredGoogleProvider
        let nonceHash: Buffer
        {
          // 좁힌 입력은 token 호출을 시작하는 block에서만 보유한다.
          const providerInput = input
          const hasInput = providerInput != null
          if (!hasInput) {
            throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
          }
          signal = providerInput.signal
          const isInitiallyAborted = signal.aborted
          if (isInitiallyAborted) {
            throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
          }
          const resolvedRegistration = registrations.get(providerInput.snapshot.version)
          const hasRegistration = resolvedRegistration != null
          const hasMatchingSnapshot =
            hasRegistration && sameSnapshot(resolvedRegistration.snapshot, providerInput.snapshot)
          if (!hasMatchingSnapshot) {
            throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
          }
          registration = resolvedRegistration
          const storedNonceHash = providerInput.nonceHash
          const isNonceHashBuffer = Buffer.isBuffer(storedNonceHash)
          const hasNonceHashBytes = isNonceHashBuffer && storedNonceHash.length === 32
          const isValidNonceHash = isNonceHashBuffer && hasNonceHashBytes
          if (!isValidNonceHash) {
            throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
          }
          nonceHash = Buffer.from(storedNonceHash)
          const isCodeString = typeof providerInput.code === 'string'
          const hasCode = isCodeString && providerInput.code.length > 0
          const isValidCode = isCodeString && hasCode
          if (!isValidCode) {
            throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
          }
          try {
            // 공통 proof parser의 형식 오류는 provider adapter 입력 경계에서 정제한다.
            decodeOpaque(providerInput.providerVerifier)
          } catch {
            throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
          }

          // Token 교환에는 저장 snapshot만 사용하고 active registry를 조회하지 않는다.
          exchange = exchangeGoogleCode(registration, providerInput, resolveSecret, fetchGoogle)
        }
        input = undefined
        response = await exchange
        exchange = undefined
        {
          // 검증용 const가 block 밖의 JWKS 대기까지 원문 응답을 보유하지 않게 한다.
          const tokenResponse = response
          const isResponseObject = tokenResponse != null && typeof tokenResponse === 'object'
          if (!isResponseObject) {
            throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
          }
          const hasIdToken = 'id_token' in tokenResponse
          const candidateIdToken = hasIdToken ? tokenResponse.id_token : undefined
          const isIdTokenString = typeof candidateIdToken === 'string'
          const isIdTokenEmpty = isIdTokenString && candidateIdToken.length === 0
          const isValidTokenResponse = hasIdToken && isIdTokenString && !isIdTokenEmpty
          if (!isValidTokenResponse) {
            throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
          }
          idToken = candidateIdToken
          const hasAccessToken = 'access_token' in tokenResponse
          accessToken = hasAccessToken ? tokenResponse.access_token : undefined
        }
        response = undefined

        // 자체 ES256 JWT issuer/key/type와 공유하지 않는 Google RS256 신뢰 경계다.
        try {
          const verified = await withAbort(
            jwtVerify(idToken, (header, token) => registration.resolveKey(header, token, signal), {
              algorithms: ['RS256'],
              issuer: ['https://accounts.google.com', 'accounts.google.com'],
              audience: registration.snapshot.providerClientId,
              requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce'],
              clockTolerance: 0
            }),
            signal
          )
          payload = verified.payload
        } catch (error) {
          throw loginFailure(error, LOGIN_ERRORS.PROVIDER)
        }
        const isAbortedAfterSignature = signal.aborted
        if (isAbortedAfterSignature) {
          throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
        }
        const subject = verifyGoogleClaims(payload, registration.snapshot, nonceHash, accessToken)
        const isAbortedAfterClaims = signal.aborted
        if (isAbortedAfterClaims) {
          throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
        }
        return { provider: 'google', subject }
      } catch (error) {
        throw loginFailure(error, LOGIN_ERRORS.PROVIDER)
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
  } catch (error) {
    throw loginFailure(error, LOGIN_ERRORS.INTERNAL)
  }
}
