import { evaluateReviewRequest } from "./eligibility.mjs";

export function pullRequestNumber(event) {
  return event.workflow_run?.pull_requests?.[0]?.number ?? null;
}

export function evaluateWorkflowRunSource(event) {
  if (event.workflow_run?.conclusion !== "success") {
    return { eligible: false, reason: "source_workflow_failed" };
  }
  if (event.workflow_run.event !== "pull_request") {
    return { eligible: false, reason: "unsupported_source_event" };
  }
  if (pullRequestNumber(event) === null) {
    return { eligible: false, reason: "pull_request_missing" };
  }
  return { eligible: true, reason: "eligible" };
}

export function evaluateTrustedReviewRequest(
  event,
  pullRequest,
  { label = "@ldb-review" } = {},
) {
  const source = evaluateWorkflowRunSource(event);
  if (!source.eligible) {
    return source;
  }
  if (pullRequest.number !== pullRequestNumber(event)) {
    return { eligible: false, reason: "pull_request_mismatch" };
  }

  const eligibility = evaluateReviewRequest(
    {
      action: "synchronize",
      repository: event.repository,
      pull_request: pullRequest,
    },
    { label },
  );
  if (!eligibility.eligible) {
    return eligibility;
  }
  if (pullRequest.head.sha !== event.workflow_run.head_sha) {
    return { eligible: false, reason: "stale_head" };
  }
  return { eligible: true, reason: "eligible" };
}
