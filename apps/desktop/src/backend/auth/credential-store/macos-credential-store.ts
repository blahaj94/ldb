import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { SafeStorage } from 'electron'
import { isCanonicalOpaque } from '../pkce'
import type {
  CredentialInspection,
  CredentialStore,
  CredentialTransitionKind,
  StoreMutationOutcome
} from '../types'
import {
  MAX_RECORD_BYTES,
  encodeCredentialRecord,
  markerSchema,
  parseStoredJson,
  readCiphertext,
  readRefreshToken,
  validateCredentialContext
} from './credential-record'
import type { CredentialContext } from './credential-record'
import { MacOsCredentialFiles } from './macos-credential-files'
import type { CredentialFiles } from './macos-credential-files'

type StoreOptions = Readonly<{
  userDataPath: string
  context: CredentialContext
  safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>
  files?: CredentialFiles
  platform?: NodeJS.Platform
}>
type OwnedMarker = Readonly<{ version: 1; operationId: string; kind: CredentialTransitionKind }>

// Main의 단일 coordinator가 이 instance와 writer를 소유한다. Generation/HTTP/복구 종료는 port 호출자가 결정한다.
export function createMacOsCredentialStore(options: StoreOptions): CredentialStore {
  const isMacOs = (options.platform ?? process.platform) === 'darwin'
  if (!isMacOs) {
    const rejectMutation = async (): Promise<StoreMutationOutcome> => 'failed'
    return {
      inspect: async () => ({ status: 'unavailable' }),
      establishTransition: rejectMutation,
      reestablishTransition: rejectMutation,
      commitCredential: rejectMutation,
      clearCredential: rejectMutation,
      removeTransition: rejectMutation
    }
  }
  const hasAbsolutePath = isAbsolute(options.userDataPath)
  if (!hasAbsolutePath) {
    throw new Error('Credential storage requires a trusted absolute path.')
  }
  const context = validateCredentialContext(options.context)
  const files = new MacOsCredentialFiles(options.userDataPath, context.environment, options.files)
  const safeStorage = options.safeStorage
  let ownedMarker: OwnedMarker | null = null

  async function inspect(): Promise<CredentialInspection> {
    try {
      await files.prepare()
      const hasMarker = await files.present('transition.v1')
      const hasTemporary = (await files.ownedTemporaries()).length > 0
      const requiresRecovery = hasMarker || hasTemporary
      if (requiresRecovery) {
        return { status: 'recovery-required' }
      }
      const isEncryptionAvailable = safeStorage.isEncryptionAvailable()
      if (!isEncryptionAvailable) {
        return { status: 'unavailable' }
      }
      const record = await files.read('credential.v1')
      const isEmpty = record == null
      if (isEmpty) {
        const probe = 'ldb-credential-store-probe-v1'
        const decrypted = safeStorage.decryptString(safeStorage.encryptString(probe))
        const isRoundTripSuccessful = decrypted === probe
        return { status: isRoundTripSuccessful ? 'empty' : 'unavailable' }
      }
      const ciphertext = readCiphertext(record, context)
      const isInvalidRecord = ciphertext == null
      if (isInvalidRecord) {
        return { status: 'recovery-required' }
      }
      const plaintext = safeStorage.decryptString(ciphertext)
      const refreshToken = readRefreshToken(plaintext, context)
      const isInvalidPayload = refreshToken == null
      return isInvalidPayload ? { status: 'recovery-required' } : { status: 'ready', refreshToken }
    } catch {
      return { status: 'unavailable' }
    }
  }

  async function writeMarker(
    kind: CredentialTransitionKind,
    replaceExisting: boolean
  ): Promise<StoreMutationOutcome> {
    try {
      await files.prepare()
      const hasExistingMarker = await files.present('transition.v1')
      const cannotReplace = hasExistingMarker && !replaceExisting
      if (cannotReplace) {
        return 'failed'
      }
      const marker: OwnedMarker = { version: 1, operationId: randomUUID(), kind }
      const outcome = await files.replace('transition.v1', Buffer.from(JSON.stringify(marker)))
      const wasConfirmed = outcome === 'confirmed'
      ownedMarker = wasConfirmed ? marker : null
      return outcome
    } catch {
      return 'failed'
    }
  }

  async function ownsMarker(): Promise<boolean> {
    const marker = ownedMarker
    const hasOwnership = marker != null
    if (!hasOwnership) {
      return false
    }
    await files.prepare()
    const bytes = await files.read('transition.v1')
    const hasRecord = bytes != null
    if (!hasRecord) {
      return false
    }
    const parsed = markerSchema.safeParse(parseStoredJson(bytes))
    if (!parsed.success) {
      return false
    }
    const hasSameOperation = parsed.data.operationId === marker.operationId
    const hasSameKind = parsed.data.kind === marker.kind
    const hasSameMarker = hasSameOperation && hasSameKind
    return hasSameMarker
  }

  async function commitCredential(refreshToken: string): Promise<StoreMutationOutcome> {
    try {
      const isCanonical = isCanonicalOpaque(refreshToken)
      const isClearMarker = ownedMarker?.kind === 'clear'
      const ownsTransition = await ownsMarker()
      const canCommit = isCanonical && !isClearMarker && ownsTransition
      if (!canCommit) {
        return 'failed'
      }
      const isEncryptionAvailable = safeStorage.isEncryptionAvailable()
      if (!isEncryptionAvailable) {
        return 'failed'
      }
      const ciphertext = safeStorage.encryptString(
        JSON.stringify({ version: 1, ...context, refreshToken })
      )
      const hasCiphertext = ciphertext.byteLength > 0
      if (!hasCiphertext) {
        return 'failed'
      }
      const record = encodeCredentialRecord(context, ciphertext)
      const isWithinLimit = record.byteLength <= MAX_RECORD_BYTES
      if (!isWithinLimit) {
        return 'failed'
      }
      return files.replace('credential.v1', record)
    } catch {
      return 'failed'
    }
  }

  async function clearCredential(): Promise<StoreMutationOutcome> {
    try {
      const isClearMarker = ownedMarker?.kind === 'clear'
      const ownsTransition = await ownsMarker()
      const canClear = isClearMarker && ownsTransition
      return canClear ? files.clear() : 'failed'
    } catch {
      return 'failed'
    }
  }

  async function removeTransition(): Promise<StoreMutationOutcome> {
    try {
      const ownsTransition = await ownsMarker()
      if (!ownsTransition) {
        return 'unknown'
      }
      const outcome = await files.removeMarker()
      const wasConfirmed = outcome === 'confirmed'
      if (wasConfirmed) {
        ownedMarker = null
      }
      return outcome
    } catch {
      return 'unknown'
    }
  }

  return {
    inspect,
    establishTransition: (kind) => {
      const canReplaceForClear = kind === 'clear'
      return writeMarker(kind, canReplaceForClear)
    },
    reestablishTransition: (kind) => writeMarker(kind, true),
    commitCredential,
    clearCredential,
    removeTransition
  }
}
