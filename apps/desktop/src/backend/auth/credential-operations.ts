import type { CredentialStore, CredentialTransitionKind } from './types'

export type TransitionPreparation = 'established' | 'failed' | 'unconfirmed'
export type CredentialCommit = 'committed' | 'save-failed' | 'clear-unconfirmed'
export type CredentialClear = 'cleared' | 'unconfirmed'

export async function prepareCredentialTransition(
  store: CredentialStore,
  kind: CredentialTransitionKind
): Promise<TransitionPreparation> {
  const establishmentResult = await store.establishTransition(kind)
  const isEstablishmentConfirmed = establishmentResult === 'confirmed'
  if (isEstablishmentConfirmed) {
    return 'established'
  }
  const isEstablishmentFailed = establishmentResult === 'failed'
  if (isEstablishmentFailed) {
    return 'failed'
  }

  const reestablishmentResult = await store.reestablishTransition(kind)
  const isReestablished = reestablishmentResult === 'confirmed'
  return isReestablished ? 'established' : 'unconfirmed'
}

export async function finalizeCredentialTransition(
  store: CredentialStore,
  kind: CredentialTransitionKind
): Promise<CredentialCommit> {
  const removalResult = await store.removeTransition()
  const isRemovalConfirmed = removalResult === 'confirmed'
  if (isRemovalConfirmed) {
    return 'committed'
  }
  const isRemovalFailed = removalResult === 'failed'
  if (isRemovalFailed) {
    return 'save-failed'
  }

  const reestablishmentResult = await store.reestablishTransition(kind)
  const isAutomaticRestoreBlocked = reestablishmentResult === 'confirmed'
  return isAutomaticRestoreBlocked ? 'save-failed' : 'clear-unconfirmed'
}

export async function clearCredential(store: CredentialStore): Promise<CredentialClear> {
  const prepared = await prepareCredentialTransition(store, 'clear')
  const canClear = prepared === 'established'
  if (!canClear) {
    return 'unconfirmed'
  }

  return finishCredentialClear(store)
}

export async function finishCredentialClear(store: CredentialStore): Promise<CredentialClear> {
  const clearResult = await store.clearCredential()
  const isCredentialCleared = clearResult === 'confirmed'
  if (!isCredentialCleared) {
    return 'unconfirmed'
  }

  const removalResult = await store.removeTransition()
  const isClean = removalResult === 'confirmed'
  if (isClean) {
    return 'cleared'
  }

  const isRemovalUnknown = removalResult === 'unknown'
  if (isRemovalUnknown) {
    await store.reestablishTransition('clear')
  }
  return 'unconfirmed'
}
