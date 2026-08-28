const SUPPORTED_ACTIONS = new Set([
  "labeled",
  "synchronize",
  "ready_for_review",
  "reopened",
]);

export function evaluateReviewRequest(event, { label = "@ldb-review" } = {}) {
  if (!SUPPORTED_ACTIONS.has(event.action)) {
    return { eligible: false, reason: "unsupported_action" };
  }

  if (event.action === "labeled" && event.label?.name !== label) {
    return { eligible: false, reason: "label_event_mismatch" };
  }

  const pullRequest = event.pull_request;
  if (!pullRequest?.labels?.some((item) => item.name === label)) {
    return { eligible: false, reason: "label_missing" };
  }

  if (pullRequest.draft) {
    return { eligible: false, reason: "draft" };
  }

  if (pullRequest.head?.repo?.full_name !== event.repository?.full_name) {
    return { eligible: false, reason: "fork" };
  }

  return { eligible: true, reason: "eligible" };
}
