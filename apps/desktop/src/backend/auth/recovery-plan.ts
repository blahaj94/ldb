import type { ClockReading, CredentialInspection } from './types'

export type StorageRecoveryPurpose = 'inspect-store' | 'clear-store'
export type RecoveryPurpose = StorageRecoveryPurpose | 'resume-credential'
type StoreRecoveryStep = 'storage-blocked' | 'signed-out' | 'clear-store' | 'restore-ready'
type CredentialRecoveryStep = 'verify-user' | 'refresh-credential'

export function selectStoreRecoveryStep(
  purpose: StorageRecoveryPurpose,
  status: CredentialInspection['status']
): StoreRecoveryStep {
  const isUnavailable = status === 'unavailable'
  if (isUnavailable) {
    return 'storage-blocked'
  }
  const isEmpty = status === 'empty'
  if (isEmpty) {
    return 'signed-out'
  }
  const hasRecoveryRecord = status === 'recovery-required'
  const requiresCleanup = purpose === 'clear-store'
  const shouldClear = hasRecoveryRecord || requiresCleanup
  if (shouldClear) {
    return 'clear-store'
  }
  return 'restore-ready'
}

export function selectCredentialRecoveryStep(
  checkedAt: ClockReading,
  accessTokenExpiresAtMs: number
): CredentialRecoveryStep {
  const isClockUsable = !checkedAt.discontinuous
  const isAccessCurrent = checkedAt.wallMs < accessTokenExpiresAtMs
  const canVerify = isClockUsable && isAccessCurrent
  return canVerify ? 'verify-user' : 'refresh-credential'
}
