import { createHash } from 'node:crypto'

const PKCE_BYTES = 32
const PKCE_LENGTH = 43
const CANONICAL_BASE64URL = /^[A-Za-z0-9_-]{43}$/

export type Pkce = Readonly<{
  verifier: string
  challenge: string
}>

export function isCanonicalOpaque(value: unknown): value is string {
  const isString = typeof value === 'string'
  const hasCanonicalCharacters = isString && CANONICAL_BASE64URL.test(value)
  if (!hasCanonicalCharacters) {
    return false
  }

  const decoded = Buffer.from(value, 'base64url')
  const hasExpectedBytes = decoded.length === PKCE_BYTES
  const hasCanonicalEncoding = decoded.toString('base64url') === value
  const isCanonical = hasExpectedBytes && hasCanonicalEncoding

  return isCanonical
}

export function createPkce(bytes: (size: number) => Uint8Array): Pkce {
  const random = bytes(PKCE_BYTES)
  const hasExpectedBytes = random.byteLength === PKCE_BYTES
  if (!hasExpectedBytes) {
    throw new Error('PKCE generation failed.')
  }

  const verifier = Buffer.from(random).toString('base64url')
  const hasExpectedLength = verifier.length === PKCE_LENGTH
  const isCanonicalVerifier = isCanonicalOpaque(verifier)
  const isValidVerifier = hasExpectedLength && isCanonicalVerifier
  if (!isValidVerifier) {
    throw new Error('PKCE generation failed.')
  }

  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
  return { verifier, challenge }
}
