const SUPPORTED_ACTIONS = new Set([
  "labeled",
  "synchronize",
  "ready_for_review",
  "reopened",
]);

export function evaluateReviewRequest(event, { label = "@ldb-review" } = {}) {
  const isSupportedAction = SUPPORTED_ACTIONS.has(event.action);
  if (!isSupportedAction) {
    return { eligible: false, reason: "unsupported_action" };
  }

  const isLabeledEvent = event.action === "labeled";
  const isLabeledEventWithWrongLabel =
    isLabeledEvent && event.label?.name !== label;
  if (isLabeledEventWithWrongLabel) {
    return { eligible: false, reason: "label_event_mismatch" };
  }

  const pullRequest = event.pull_request;
  const hasRequiredLabel = pullRequest?.labels?.some(
    (item) => item.name === label,
  );
  if (!hasRequiredLabel) {
    return { eligible: false, reason: "label_missing" };
  }

  const isDraft = pullRequest.draft;
  if (isDraft) {
    return { eligible: false, reason: "draft" };
  }

  const isFork =
    pullRequest.head?.repo?.full_name !== event.repository?.full_name;
  if (isFork) {
    return { eligible: false, reason: "fork" };
  }

  return { eligible: true, reason: "eligible" };
}
