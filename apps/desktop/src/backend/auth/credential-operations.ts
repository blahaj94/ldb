import type { CredentialStore, CredentialTransitionKind } from './types'

export type TransitionPreparation = 'established' | 'failed' | 'unconfirmed'
export type CredentialCommit = 'committed' | 'save-failed' | 'clear-unconfirmed'
export type CredentialClear = 'cleared' | 'unconfirmed'

export async function prepareCredentialTransition(
  store: CredentialStore,
  kind: CredentialTransitionKind
): Promise<TransitionPreparation> {
  const established = await store.establishTransition(kind)
  if (established === 'confirmed') {
    return 'established'
  }
  if (established === 'failed') {
    return 'failed'
  }

  const reestablished = await store.reestablishTransition(kind)
  const isReestablished = reestablished === 'confirmed'
  return isReestablished ? 'established' : 'unconfirmed'
}

export async function commitCredentialTransition(
  store: CredentialStore,
  refreshToken: string,
  kind: CredentialTransitionKind
): Promise<CredentialCommit> {
  const committed = await store.commitCredential(refreshToken)
  const isCredentialCommitted = committed === 'confirmed'
  if (!isCredentialCommitted) {
    return 'save-failed'
  }

  const removed = await store.removeTransition()
  if (removed === 'confirmed') {
    return 'committed'
  }
  if (removed === 'failed') {
    return 'save-failed'
  }

  const reestablished = await store.reestablishTransition(kind)
  const isAutomaticRestoreBlocked = reestablished === 'confirmed'
  return isAutomaticRestoreBlocked ? 'save-failed' : 'clear-unconfirmed'
}

export async function clearCredential(store: CredentialStore): Promise<CredentialClear> {
  const prepared = await prepareCredentialTransition(store, 'clear')
  const canClear = prepared === 'established'
  if (!canClear) {
    return 'unconfirmed'
  }

  const cleared = await store.clearCredential()
  const isCredentialCleared = cleared === 'confirmed'
  if (!isCredentialCleared) {
    return 'unconfirmed'
  }

  const removed = await store.removeTransition()
  const isClean = removed === 'confirmed'
  if (isClean) {
    return 'cleared'
  }

  if (removed === 'unknown') {
    await store.reestablishTransition('clear')
  }
  return 'unconfirmed'
}
