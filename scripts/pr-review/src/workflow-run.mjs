import { evaluateReviewRequest } from './eligibility.mjs'

export function pullRequestNumber(event) {
  return event.workflow_run?.pull_requests?.[0]?.number ?? null
}

export function evaluateWorkflowRunSource(event) {
  const isSuccessfulWorkflow = event.workflow_run?.conclusion === 'success'
  if (!isSuccessfulWorkflow) {
    return { eligible: false, reason: 'source_workflow_failed' }
  }
  const isPullRequestEvent = event.workflow_run.event === 'pull_request'
  if (!isPullRequestEvent) {
    return { eligible: false, reason: 'unsupported_source_event' }
  }
  const hasPullRequest = pullRequestNumber(event) !== null
  if (!hasPullRequest) {
    return { eligible: false, reason: 'pull_request_missing' }
  }
  return { eligible: true, reason: 'eligible' }
}

export function evaluateTrustedReviewRequest(event, pullRequest, { label = '@ldb-review' } = {}) {
  const source = evaluateWorkflowRunSource(event)
  if (!source.eligible) {
    return source
  }
  const hasMatchingPullRequestNumber = pullRequest.number === pullRequestNumber(event)
  if (!hasMatchingPullRequestNumber) {
    return { eligible: false, reason: 'pull_request_mismatch' }
  }

  const eligibility = evaluateReviewRequest(
    {
      action: 'synchronize',
      repository: event.repository,
      pull_request: pullRequest
    },
    { label }
  )
  if (!eligibility.eligible) {
    return eligibility
  }
  const hasMatchingHeadSha = pullRequest.head.sha === event.workflow_run.head_sha
  if (!hasMatchingHeadSha) {
    return { eligible: false, reason: 'stale_head' }
  }
  return { eligible: true, reason: 'eligible' }
}
