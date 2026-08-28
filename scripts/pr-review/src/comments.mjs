export const POLICY_MARKER = "<!-- ldb-ai-review-policy -->";

const STATUS_ICON = {
  pass: "✅",
  warning: "⚠️",
  skipped: "➖",
};

function cell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

export function providerMarker(provider, headSha) {
  return `<!-- ldb-ai-review:${provider}:${headSha} -->`;
}

export function buildProviderTriggerComment({ provider, headSha }) {
  if (provider !== "codex") {
    throw new Error(`Unsupported review provider: ${provider}`);
  }

  return [
    providerMarker(provider, headSha),
    "@codex review",
    "",
    `_Automated advisory review request for \`${headSha}\`._`,
  ].join("\n");
}

export function findCommentByMarker(comments, marker) {
  return comments.find((comment) => comment.body?.includes(marker));
}

export function buildPolicySummary({ headSha, checks }) {
  const rows = checks.map(
    ({ name, status, detail }) =>
      `| ${cell(name)} | ${STATUS_ICON[status] ?? "❔"} ${cell(status)} | ${cell(detail)} |`,
  );

  return [
    POLICY_MARKER,
    "## AI review policy check — Advisory",
    "",
    `Head: \`${headSha}\``,
    "",
    "| Check | Status | Detail |",
    "| --- | --- | --- |",
    ...rows,
    "",
    "Warnings do not block merge. The repository owner makes the final decision.",
  ].join("\n");
}
