import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { AuthLoginRequest } from '../../database/schemas/auth-login-requests.js'
import type { ProviderPkceConfiguration } from '../../types/login.js'

export function decodeOpaque(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  return bytes
}

export function opaqueHash(value: string): Buffer {
  return createHash('sha256').update(decodeOpaque(value)).digest()
}

export function newOpaque(): string {
  try { return randomBytes(32).toString('base64url') } catch { throw new LoginFailure(LOGIN_ERRORS.INTERNAL) }
}

export function challenge(verifier: string): string {
  decodeOpaque(verifier)
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function equalHash(a: Buffer | null, b: Buffer): boolean {
  return a !== null && a.length === b.length && timingSafeEqual(a, b)
}

type PkceContext = Pick<AuthLoginRequest, 'id' | 'provider' | 'purpose'>
type SealedPkce = Pick<AuthLoginRequest, 'providerPkceCiphertext' | 'providerPkceIv' | 'providerPkceTag' | 'providerPkceKeyId'>
const aad = ({ id, provider, purpose }: PkceContext): Buffer => Buffer.from(JSON.stringify([id, provider, purpose]), 'utf8')

export class ProviderPkceKeys {
  readonly #keys = new Map<string, Buffer>()
  readonly #active: string

  constructor(config: ProviderPkceConfiguration) {
    try {
      this.#active = config.activeKeyId
      for (const { id, key } of config.keys) {
        if (!id || this.#keys.has(id) || !Buffer.isBuffer(key) || key.length !== 32) throw new Error()
        this.#keys.set(id, Buffer.from(key))
      }
      if (!this.#keys.has(this.#active)) throw new Error()
    } catch { throw new LoginFailure(LOGIN_ERRORS.INTERNAL) }
  }

  encrypt(verifier: string, context: PkceContext): SealedPkce {
    try {
      decodeOpaque(verifier)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', this.#keys.get(this.#active)!, iv, { authTagLength: 16 })
      cipher.setAAD(aad(context))
      const ciphertext = Buffer.concat([cipher.update(verifier, 'ascii'), cipher.final()])
      return { providerPkceCiphertext: ciphertext, providerPkceIv: iv, providerPkceTag: cipher.getAuthTag(), providerPkceKeyId: this.#active }
    } catch { throw new LoginFailure(LOGIN_ERRORS.INTERNAL) }
  }

  decrypt(row: PkceContext & SealedPkce): string {
    try {
      const key = this.#keys.get(row.providerPkceKeyId!)
      if (!key || !row.providerPkceCiphertext || !row.providerPkceIv || !row.providerPkceTag) throw new Error()
      const decipher = createDecipheriv('aes-256-gcm', key, row.providerPkceIv, { authTagLength: 16 })
      decipher.setAAD(aad(row))
      decipher.setAuthTag(row.providerPkceTag)
      const verifier = Buffer.concat([decipher.update(row.providerPkceCiphertext), decipher.final()]).toString('ascii')
      decodeOpaque(verifier)
      return verifier
    } catch { throw new LoginFailure(LOGIN_ERRORS.INTERNAL) }
  }
}
