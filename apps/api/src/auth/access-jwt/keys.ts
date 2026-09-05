import { CompactSign, compactVerify, importPKCS8, importSPKI } from 'jose'
import { ACCESS_JWT_ALGORITHM } from './constants.js'
import { AccessJwtError } from './errors.js'
import type { AccessJwtIssuerConfiguration, AccessJwtVerifierConfiguration } from './types.js'

function requiredString(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AccessJwtError('INVALID_ACCESS_JWT_CONFIGURATION')
  }
}

function requireEs256(key: CryptoKey, type: 'private' | 'public'): void {
  if (key.type !== type || key.algorithm.name !== 'ECDSA' ||
    (key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256') {
    throw new AccessJwtError('INVALID_ACCESS_JWT_CONFIGURATION')
  }
}

// 호출 factory가 모든 실패를 정제한다. PEM이나 하위 crypto error를 반환하지 않는다.
export async function loadVerificationKeys(config: AccessJwtVerifierConfiguration) {
  requiredString(config.issuer)
  requiredString(config.audience)
  if (!Array.isArray(config.verificationKeys) || config.verificationKeys.length === 0) {
    throw new AccessJwtError('INVALID_ACCESS_JWT_CONFIGURATION')
  }
  const keys = new Map<string, CryptoKey>()
  for (const entry of config.verificationKeys) {
    requiredString(entry.kid)
    requiredString(entry.publicKeyPem)
    if (keys.has(entry.kid)) throw new AccessJwtError('INVALID_ACCESS_JWT_CONFIGURATION')
    const key = await importSPKI(entry.publicKeyPem, ACCESS_JWT_ALGORITHM)
    requireEs256(key, 'public')
    keys.set(entry.kid, key)
  }
  return keys
}

export async function loadSigningKey(
  config: AccessJwtIssuerConfiguration,
  verificationKeys: ReadonlyMap<string, CryptoKey>,
) {
  const { kid, privateKeyPem } = config.signingKey
  requiredString(kid)
  requiredString(privateKeyPem)
  const publicKey = verificationKeys.get(kid)
  if (!publicKey) throw new AccessJwtError('INVALID_ACCESS_JWT_CONFIGURATION')
  const privateKey = await importPKCS8(privateKeyPem, ACCESS_JWT_ALGORITHM)
  requireEs256(privateKey, 'private')
  // listen 전에 등록 public key와 signing key의 일치를 검증한다. Key 생성은 하지 않는다.
  const probe = await new CompactSign(new TextEncoder().encode('access-jwt-key-check'))
    .setProtectedHeader({ alg: ACCESS_JWT_ALGORITHM })
    .sign(privateKey)
  await compactVerify(probe, publicKey, { algorithms: [ACCESS_JWT_ALGORITHM] })
  return { kid, privateKey }
}
