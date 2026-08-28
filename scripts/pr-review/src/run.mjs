import { appendFile, readFile } from "node:fs/promises";

import {
  POLICY_MARKER,
  buildPolicySummary,
  findCommentByMarker,
} from "./comments.mjs";
import { evaluateReviewRequest } from "./eligibility.mjs";
import { GitHubClient } from "./github-client.mjs";
import { buildPolicyReport } from "./policy.mjs";
import { codexProvider } from "./providers/codex.mjs";

const PROVIDERS = new Map([[codexProvider.id, codexProvider]]);

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function writeStepSummary(content) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${content}\n`);
  }
}

async function main() {
  const eventPath = requiredEnvironment("GITHUB_EVENT_PATH");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const label = process.env.REVIEW_LABEL ?? "@ldb-review";
  const eligibility = evaluateReviewRequest(event, { label });

  if (!eligibility.eligible) {
    const message = `AI review skipped: ${eligibility.reason}`;
    console.log(message);
    await writeStepSummary(message);
    return;
  }

  const providerId = process.env.REVIEW_PROVIDER ?? "codex";
  const provider = PROVIDERS.get(providerId);
  if (!provider) throw new Error(`Unsupported REVIEW_PROVIDER: ${providerId}`);

  const pullRequest = event.pull_request;
  const client = new GitHubClient({
    token: requiredEnvironment("GITHUB_TOKEN"),
    repository: event.repository.full_name,
  });
  const [comments, files, commits] = await Promise.all([
    client.listComments(pullRequest.number),
    client.listFiles(pullRequest.number),
    client.listCommits(pullRequest.number),
  ]);
  const automationComments = comments.filter(
    (comment) => comment.user?.login === "github-actions[bot]",
  );

  const report = buildPolicyReport({
    pullRequest,
    repositoryOwner: event.repository.owner.login,
    files,
    commits,
    comments,
  });
  const summary = buildPolicySummary({
    headSha: pullRequest.head.sha,
    checks: report.checks,
  });
  const previousSummary = findCommentByMarker(automationComments, POLICY_MARKER);
  if (previousSummary) {
    await client.updateComment(previousSummary.id, summary);
  } else {
    await client.createComment(pullRequest.number, summary);
  }

  const marker = provider.marker(pullRequest.head.sha);
  if (findCommentByMarker(automationComments, marker)) {
    console.log(`Provider review already requested for ${pullRequest.head.sha}`);
  } else {
    await client.createComment(
      pullRequest.number,
      provider.triggerComment(pullRequest.head.sha),
    );
    console.log(`Requested ${provider.id} review for ${pullRequest.head.sha}`);
  }
  await writeStepSummary(summary);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
