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
  const isUnsupportedProvider = provider !== "codex";
  if (isUnsupportedProvider) {
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
  const matchingComment = comments.find(
    (comment) => {
      const hasMarker = comment.body?.includes(marker);
      return hasMarker;
    },
  );
  return matchingComment;
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
