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
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    Number.isFinite(new Date(value * 1000).getTime())
  )
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
      if (
        !input ||
        !isUuid(input.userId) ||
        !isUuid(input.sessionId) ||
        !isTimestamp(input.issuedAt) ||
        !isTimestamp(input.idleDeadline)
      ) {
        throw new AccessJwtError('INVALID_ACCESS_JWT_INPUT')
      }
      const { userId, sessionId, issuedAt, idleDeadline } = input
      const expiresAt = Math.min(issuedAt + ACCESS_JWT_MAX_AGE_SECONDS, idleDeadline)
      if (!isTimestamp(expiresAt) || expiresAt <= issuedAt) {
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
        if (typeof token !== 'string' || !isTimestamp(now)) {
          throw new AccessJwtError('INVALID_ACCESS_JWT')
        }
        const { payload } = await jwtVerify(
          token,
          (header) => {
            // jose의 typ normalization보다 엄격한 exact type과 local kid allowlist를 적용한다.
            if (
              header.alg !== ACCESS_JWT_ALGORITHM ||
              header.typ !== ACCESS_JWT_TYPE ||
              typeof header.kid !== 'string' ||
              !keys.has(header.kid)
            ) {
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
        if (
          payload.iss !== issuer ||
          payload.aud !== audience ||
          Object.hasOwn(payload, 'nbf') ||
          !isUuid(sub) ||
          !isUuid(sid) ||
          !isUuid(jti) ||
          !isTimestamp(iat) ||
          !isTimestamp(exp) ||
          iat > now ||
          now >= exp ||
          exp <= iat ||
          exp - iat > ACCESS_JWT_MAX_AGE_SECONDS
        ) {
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
