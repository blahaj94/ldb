const SUPPORTED_ACTIONS = new Set(['labeled', 'synchronize', 'ready_for_review', 'reopened'])

export function evaluateReviewRequest(event, { label = '@ldb-review' } = {}) {
  const isSupportedAction = SUPPORTED_ACTIONS.has(event.action)
  if (!isSupportedAction) {
    return { eligible: false, reason: 'unsupported_action' }
  }

  const isLabeledEvent = event.action === 'labeled'
  if (isLabeledEvent) {
    const isEventLabelMatch = event.label?.name === label
    if (!isEventLabelMatch) {
      return { eligible: false, reason: 'label_event_mismatch' }
    }
  }

  const pullRequest = event.pull_request
  const hasRequiredLabel = pullRequest?.labels?.some((item) => {
    const isMatchingLabel = item.name === label
    return isMatchingLabel
  })
  const isRequiredLabelResultMissing = hasRequiredLabel == null
  const isRequiredLabelMissing = isRequiredLabelResultMissing || !hasRequiredLabel
  if (isRequiredLabelMissing) {
    return { eligible: false, reason: 'label_missing' }
  }

  const isDraft = pullRequest.draft
  if (isDraft) {
    return { eligible: false, reason: 'draft' }
  }

  const isFork = pullRequest.head?.repo?.full_name !== event.repository?.full_name
  if (isFork) {
    return { eligible: false, reason: 'fork' }
  }

  return { eligible: true, reason: 'eligible' }
}
