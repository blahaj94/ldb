import { readFile } from "node:fs/promises";

import { findCommentByMarker } from "./comments.mjs";
import { GitHubClient } from "./github-client.mjs";
import { codexProvider } from "./providers/codex.mjs";
import {
  evaluateTrustedReviewRequest,
  evaluateWorkflowRunSource,
  pullRequestNumber,
} from "./workflow-run.mjs";

const PROVIDERS = new Map([[codexProvider.id, codexProvider]]);

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const event = JSON.parse(
    await readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"),
  );
  const source = evaluateWorkflowRunSource(event);
  if (!source.eligible) {
    console.log(`AI provider trigger skipped: ${source.reason}`);
    return;
  }

  const providerId = process.env.REVIEW_PROVIDER ?? "codex";
  const provider = PROVIDERS.get(providerId);
  if (!provider) throw new Error(`Unsupported REVIEW_PROVIDER: ${providerId}`);

  const client = new GitHubClient({
    token: requiredEnvironment("REVIEW_TRIGGER_TOKEN"),
    repository: event.repository.full_name,
  });
  const pullRequest = await client.getPullRequest(pullRequestNumber(event));
  const eligibility = evaluateTrustedReviewRequest(event, pullRequest, {
    label: process.env.REVIEW_LABEL ?? "@ldb-review",
  });
  if (!eligibility.eligible) {
    console.log(`AI provider trigger skipped: ${eligibility.reason}`);
    return;
  }

  const expectedActor = requiredEnvironment("REVIEW_TRIGGER_ACTOR");
  const comments = await client.listComments(pullRequest.number);
  const actorComments = comments.filter(
    (comment) => comment.user?.login === expectedActor,
  );
  const marker = provider.marker(pullRequest.head.sha);
  if (findCommentByMarker(actorComments, marker)) {
    console.log(`Provider review already requested for ${pullRequest.head.sha}`);
    return;
  }

  await client.createComment(
    pullRequest.number,
    provider.triggerComment(pullRequest.head.sha),
  );
  console.log(`Requested ${provider.id} review for ${pullRequest.head.sha}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
