type LocalCleanupEvidence = Readonly<{
  cleared: boolean
  isCurrent: boolean
  logoutOwnsCleanup: boolean
}>

type LocalCleanupDecision = Readonly<{
  shouldBlockStorage: boolean
  canContinue: boolean
}>

export function decideLocalCleanup(evidence: LocalCleanupEvidence): LocalCleanupDecision {
  if (evidence.logoutOwnsCleanup) {
    return { shouldBlockStorage: false, canContinue: false }
  }
  if (!evidence.cleared) {
    return { shouldBlockStorage: true, canContinue: false }
  }
  return { shouldBlockStorage: false, canContinue: evidence.isCurrent }
}
