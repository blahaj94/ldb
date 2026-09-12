import type { StoreMutationOutcome } from '../types'

export type CredentialRecordName = 'credential.v1' | 'transition.v1'

export type CredentialFileOperations = Readonly<{
  prepare(): Promise<void>
  present(name: string): Promise<boolean>
  ownedTemporaries(): Promise<string[]>
  read(name: CredentialRecordName): Promise<Buffer | null>
  replace(name: CredentialRecordName, data: Buffer): Promise<StoreMutationOutcome>
  clear(): Promise<StoreMutationOutcome>
  removeMarker(): Promise<StoreMutationOutcome>
}>
