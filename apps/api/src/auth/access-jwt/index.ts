import { randomUUID } from 'node:crypto'
import { jwtVerify, SignJWT } from 'jose'
import {
  ACCESS_JWT_ALGORITHM,
  ACCESS_JWT_MAX_AGE_SECONDS,
  ACCESS_JWT_REQUIRED_CLAIMS,
  ACCESS_JWT_TYPE,
  UUID_PATTERN
} from './constants.js'
import { AccessJwtError } from './errors.js'
import { loadSigningKey, loadVerificationKeys } from './keys.js'
import type {
  AccessJwtIssuerConfiguration,
  AccessJwtVerifierConfiguration,
  IssueAccessJwt,
  VerifyAccessJwt
} from './types.js'

function isUuid(value: unknown): value is string {
  const isString = typeof value === 'string'
  const hasUuidFormat = isString && UUID_PATTERN.test(value)
  return hasUuidFormat
}

function isTimestamp(value: unknown): value is number {
  const isNumber = typeof value === 'number'
  const isSafeInteger = isNumber && Number.isSafeInteger(value)
  const isRepresentableDate = isSafeInteger && Number.isFinite(new Date(value * 1000).getTime())
  return isRepresentableDate
}

function hasStringKeyId(header: { kid?: unknown }): header is { kid: string } {
  const isKeyIdString = typeof header.kid === 'string'
  return isKeyIdString
}

export async function createAccessJwtIssuer(
  configuration: AccessJwtIssuerConfiguration
): Promise<IssueAccessJwt> {
  try {
    const config = structuredClone(configuration)
    const keys = await loadVerificationKeys(config)
    const { kid, privateKey } = await loadSigningKey(config, keys)
    const { issuer, audience } = config
    return async (input) => {
      const isInputFalsy = !input
      if (isInputFalsy) {
        throw new AccessJwtError('INVALID_ACCESS_JWT_INPUT')
      }
      const hasValidUserId = isUuid(input.userId)
      const hasValidSessionId = hasValidUserId && isUuid(input.sessionId)
      const hasValidIssuedAt = hasValidSessionId && isTimestamp(input.issuedAt)
      const hasValidIdleDeadline = hasValidIssuedAt && isTimestamp(input.idleDeadline)
      if (!hasValidIdleDeadline) {
        throw new AccessJwtError('INVALID_ACCESS_JWT_INPUT')
      }
      const { userId, sessionId, issuedAt, idleDeadline } = input
      const expiresAt = Math.min(issuedAt + ACCESS_JWT_MAX_AGE_SECONDS, idleDeadline)
      const hasValidExpiration = isTimestamp(expiresAt)
      const isExpirationAfterIssue = hasValidExpiration && expiresAt > issuedAt
      if (!isExpirationAfterIssue) {
        throw new AccessJwtError('INVALID_ACCESS_JWT_INPUT')
      }
      try {
        const accessToken = await new SignJWT({ sid: sessionId })
          .setProtectedHeader({ alg: ACCESS_JWT_ALGORITHM, typ: ACCESS_JWT_TYPE, kid })
          .setIssuer(issuer)
          .setAudience(audience)
          .setSubject(userId)
          .setIssuedAt(issuedAt)
          .setExpirationTime(expiresAt)
          .setJti(randomUUID())
          .sign(privateKey)
        return { accessToken, issuedAt, expiresAt }
      } catch {
        throw new AccessJwtError('ACCESS_JWT_SIGNING_FAILED')
      }
    }
  } catch {
    throw new AccessJwtError('INVALID_ACCESS_JWT_CONFIGURATION')
  }
}

export async function createAccessJwtVerifier(
  configuration: AccessJwtVerifierConfiguration
): Promise<VerifyAccessJwt> {
  try {
    const config = structuredClone(configuration)
    const keys = await loadVerificationKeys(config)
    const { issuer, audience } = config
    return async (token, now) => {
      try {
        const isTokenString = typeof token === 'string'
        const hasValidVerificationTime = isTokenString && isTimestamp(now)
        if (!hasValidVerificationTime) {
          throw new AccessJwtError('INVALID_ACCESS_JWT')
        }
        const { payload } = await jwtVerify(
          token,
          (header) => {
            // jose의 typ normalization보다 엄격한 exact type과 local kid allowlist를 적용한다.
            const hasExpectedAlgorithm = header.alg === ACCESS_JWT_ALGORITHM
            const hasExpectedType = hasExpectedAlgorithm && header.typ === ACCESS_JWT_TYPE
            const isKeyIdString = hasExpectedType && hasStringKeyId(header)
            const hasRegisteredKey = isKeyIdString && keys.has(header.kid)
            if (!hasRegisteredKey) {
              throw new AccessJwtError('INVALID_ACCESS_JWT')
            }
            return keys.get(header.kid)!
          },
          {
            algorithms: [ACCESS_JWT_ALGORITHM],
            issuer,
            audience,
            typ: ACCESS_JWT_TYPE,
            requiredClaims: ACCESS_JWT_REQUIRED_CLAIMS,
            currentDate: new Date(now * 1000),
            clockTolerance: 0
          }
        )
        const { sub, sid, iat, exp, jti } = payload
        const hasExpectedIssuer = payload.iss === issuer
        const hasExpectedAudience = hasExpectedIssuer && payload.aud === audience
        const hasNoNotBeforeClaim = hasExpectedAudience && !Object.hasOwn(payload, 'nbf')
        if (!hasNoNotBeforeClaim) {
          throw new AccessJwtError('INVALID_ACCESS_JWT')
        }
        const hasValidUserId = isUuid(sub)
        const hasValidSessionId = hasValidUserId && isUuid(sid)
        const hasValidTokenId = hasValidSessionId && isUuid(jti)
        if (!hasValidTokenId) {
          throw new AccessJwtError('INVALID_ACCESS_JWT')
        }
        const hasValidIssuedAt = isTimestamp(iat)
        const hasValidExpiration = hasValidIssuedAt && isTimestamp(exp)
        if (!hasValidExpiration) {
          throw new AccessJwtError('INVALID_ACCESS_JWT')
        }
        const isIssuedByNow = iat <= now
        const isUnexpired = isIssuedByNow && now < exp
        const hasPositiveLifetime = isUnexpired && exp > iat
        const hasAllowedLifetime = hasPositiveLifetime && exp - iat <= ACCESS_JWT_MAX_AGE_SECONDS
        if (!hasAllowedLifetime) {
          throw new AccessJwtError('INVALID_ACCESS_JWT')
        }
        return { userId: sub, sessionId: sid, issuedAt: iat, expiresAt: exp, tokenId: jti }
      } catch {
        // jose의 claim error에는 원문 payload가 있을 수 있으므로 cause도 전달하지 않는다.
        throw new AccessJwtError('INVALID_ACCESS_JWT')
      }
    }
  } catch {
    throw new AccessJwtError('INVALID_ACCESS_JWT_CONFIGURATION')
  }
}
