import { z } from 'zod'
import { isCanonicalOpaque } from '../pkce'
import { validateApiOrigin } from '../protocol'

export const MAX_RECORD_BYTES = 16_384
const contextSchema = z.strictObject({
  environment: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  apiOrigin: z.string(),
  clientId: z.literal('desktop')
})
const recordSchema = contextSchema.extend({ version: z.literal(1), ciphertext: z.string() })
const payloadSchema = contextSchema.extend({
  version: z.literal(1),
  refreshToken: z.string().refine(isCanonicalOpaque)
})
export const markerSchema = z.strictObject({
  version: z.literal(1),
  operationId: z.uuid(),
  kind: z.enum(['exchange', 'refresh', 'clear'])
})
export type CredentialContext = z.infer<typeof contextSchema>

export function validateCredentialContext(context: CredentialContext): CredentialContext {
  const validated = contextSchema.parse(context)
  validateApiOrigin(validated.apiOrigin)
  return validated
}

function sameContext(actual: CredentialContext, expected: CredentialContext): boolean {
  const hasSameEnvironment = actual.environment === expected.environment
  const hasSameOrigin = actual.apiOrigin === expected.apiOrigin
  const hasSameClient = actual.clientId === expected.clientId
  const hasSameContext = hasSameEnvironment && hasSameOrigin && hasSameClient
  return hasSameContext
}

export function parseStoredJson(bytes: Uint8Array): unknown {
  const isWithinLimit = bytes.byteLength <= MAX_RECORD_BYTES
  if (!isWithinLimit) {
    return null
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return null
  }
}

export function readCiphertext(bytes: Uint8Array, context: CredentialContext): Buffer | null {
  const parsed = recordSchema.safeParse(parseStoredJson(bytes))
  if (!parsed.success) {
    return null
  }
  const hasMatchingContext = sameContext(parsed.data, context)
  const ciphertext = Buffer.from(parsed.data.ciphertext, 'base64')
  const isNonempty = ciphertext.byteLength > 0
  const isCanonicalEncoding = ciphertext.toString('base64') === parsed.data.ciphertext
  const isValidRecord = hasMatchingContext && isNonempty && isCanonicalEncoding
  return isValidRecord ? ciphertext : null
}

export function readRefreshToken(plaintext: string, context: CredentialContext): string | null {
  const parsed = payloadSchema.safeParse(parseStoredJson(Buffer.from(plaintext, 'utf8')))
  if (!parsed.success) {
    return null
  }
  const hasMatchingContext = sameContext(parsed.data, context)
  return hasMatchingContext ? parsed.data.refreshToken : null
}

export function encodeCredentialRecord(context: CredentialContext, ciphertext: Buffer): Buffer {
  return Buffer.from(
    JSON.stringify({ version: 1, ...context, ciphertext: ciphertext.toString('base64') })
  )
}
