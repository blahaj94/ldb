import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'
import { LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { AuthLoginRequest } from '../../database/schemas/auth-login-requests.js'
import type { ProviderPkceConfiguration } from '../../types/login.js'

export function decodeOpaque(value: unknown): Buffer {
  const isValueString = typeof value === 'string'
  const hasOpaqueFormat = isValueString && /^[A-Za-z0-9_-]{43}$/.test(value)
  const isOpaqueInvalid = !isValueString || !hasOpaqueFormat
  if (isOpaqueInvalid) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }

  const bytes = Buffer.from(value, 'base64url')
  // Decode가 성공해도 같은 32 bytes의 canonical 표현인지 다시 확인한다.
  const hasExpectedByteLength = bytes.length === 32
  const isCanonicalEncoding = hasExpectedByteLength && bytes.toString('base64url') === value
  const isDecodedOpaqueInvalid = !hasExpectedByteLength || !isCanonicalEncoding
  if (isDecodedOpaqueInvalid) {
    throw new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST)
  }
  return bytes
}

export function opaqueHash(value: string): Buffer {
  // Ticket·state·code는 인코딩된 문자열이 아닌 원래 random bytes를 hash한다.
  return createHash('sha256').update(decodeOpaque(value)).digest()
}

export function newOpaque(): string {
  try {
    return randomBytes(32).toString('base64url')
  } catch {
    throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
}

export function challenge(verifier: string): string {
  decodeOpaque(verifier)
  // PKCE S256은 opaqueHash와 달리 verifier의 ASCII 문자열을 hash한다.
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function equalHash(storedHash: Buffer | null, candidateHash: Buffer): boolean {
  const hasStoredHash = storedHash !== null
  const hasSameLength = hasStoredHash && storedHash.length === candidateHash.length
  const isHashEqual = hasSameLength && timingSafeEqual(storedHash, candidateHash)
  return isHashEqual
}

type PkceContext = Pick<AuthLoginRequest, 'id' | 'provider' | 'purpose'>
type SealedPkce = Pick<
  AuthLoginRequest,
  'providerPkceCiphertext' | 'providerPkceIv' | 'providerPkceTag' | 'providerPkceKeyId'
>

function hasCompleteSealedPkce(row: SealedPkce): row is SealedPkce & {
  providerPkceCiphertext: Buffer
  providerPkceIv: Buffer
  providerPkceTag: Buffer
} {
  const hasCiphertext = Boolean(row.providerPkceCiphertext)
  const hasIv = hasCiphertext && Boolean(row.providerPkceIv)
  const hasTag = hasIv && Boolean(row.providerPkceTag)
  const isComplete = hasCiphertext && hasIv && hasTag
  return isComplete
}

function encodePkceContext({ id, provider, purpose }: PkceContext): Buffer {
  // AAD가 ciphertext를 이 요청·provider·purpose에 묶는다. 배열 순서도 저장 형식이다.
  return Buffer.from(JSON.stringify([id, provider, purpose]), 'utf8')
}

export class ProviderPkceKeys {
  readonly #keys = new Map<string, Buffer>()
  readonly #activeKeyId: string

  constructor(config: ProviderPkceConfiguration) {
    try {
      this.#activeKeyId = config.activeKeyId
      for (const { id, key } of config.keys) {
        const hasKeyId = Boolean(id)
        const isDuplicateKey = hasKeyId && this.#keys.has(id)
        const isKeyBuffer = hasKeyId && !isDuplicateKey && Buffer.isBuffer(key)
        const hasExpectedKeyLength = isKeyBuffer && key.length === 32
        const isKeyInvalid = !hasKeyId || isDuplicateKey || !isKeyBuffer || !hasExpectedKeyLength
        if (isKeyInvalid) {
          throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
        }
        // 호출자가 원본 Buffer를 바꿔도 등록된 key는 바뀌지 않는다.
        this.#keys.set(id, Buffer.from(key))
      }

      const hasActiveKey = this.#keys.has(this.#activeKeyId)
      if (!hasActiveKey) {
        throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
      }
    } catch {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
  }

  encrypt(verifier: string, context: PkceContext): SealedPkce {
    try {
      decodeOpaque(verifier)

      // Active key는 생성자에서 확인했다. 매 암호화마다 독립적인 96-bit IV를 만든다.
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', this.#keys.get(this.#activeKeyId)!, iv, {
        authTagLength: 16
      })
      cipher.setAAD(encodePkceContext(context))
      const ciphertext = Buffer.concat([cipher.update(verifier, 'ascii'), cipher.final()])

      return {
        providerPkceCiphertext: ciphertext,
        providerPkceIv: iv,
        providerPkceTag: cipher.getAuthTag(),
        providerPkceKeyId: this.#activeKeyId
      }
    } catch {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
  }

  decrypt(row: PkceContext & SealedPkce): string {
    try {
      const key = this.#keys.get(row.providerPkceKeyId!)
      const hasKey = key != null
      const hasSealedFields = hasKey && hasCompleteSealedPkce(row)
      const isSealedPkceInvalid = !hasKey || !hasSealedFields
      if (isSealedPkceInvalid) {
        throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
      }

      // 저장 당시의 key ID와 동일한 AAD/tag로만 verifier를 복원한다.
      const decipher = createDecipheriv('aes-256-gcm', key, row.providerPkceIv, {
        authTagLength: 16
      })
      decipher.setAAD(encodePkceContext(row))
      decipher.setAuthTag(row.providerPkceTag)
      const verifierBytes = Buffer.concat([
        decipher.update(row.providerPkceCiphertext),
        decipher.final()
      ])
      const verifier = verifierBytes.toString('ascii')
      decodeOpaque(verifier)
      return verifier
    } catch {
      throw new LoginFailure(LOGIN_ERRORS.INTERNAL)
    }
  }
}
