import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTrustedReviewRequest,
  pullRequestNumber,
} from "../src/workflow-run.mjs";

function createInput(overrides = {}) {
  const pullRequest = {
    number: 4,
    draft: false,
    labels: [{ name: "@ldb-review" }],
    head: { sha: "head-sha", repo: { full_name: "dGkdu/ldb" } },
    base: { repo: { full_name: "dGkdu/ldb" } },
    ...overrides.pullRequest,
  };
  const event = {
    repository: { full_name: "dGkdu/ldb", owner: { login: "dGkdu" } },
    workflow_run: {
      conclusion: "success",
      event: "pull_request",
      head_sha: "head-sha",
      pull_requests: [{ number: 4 }],
      ...overrides.workflowRun,
    },
  };

  return { event, pullRequest };
}

test("accepts the current labeled head from a successful source workflow", () => {
  const { event, pullRequest } = createInput();

  assert.deepEqual(evaluateTrustedReviewRequest(event, pullRequest), {
    eligible: true,
    reason: "eligible",
  });
});

test("extracts the source pull request number", () => {
  const { event } = createInput();

  assert.equal(pullRequestNumber(event), 4);
});

test("rejects failed source workflows", () => {
  const { event, pullRequest } = createInput({
    workflowRun: { conclusion: "failure" },
  });

  assert.equal(
    evaluateTrustedReviewRequest(event, pullRequest).reason,
    "source_workflow_failed",
  );
});

test("rejects workflow runs without an associated pull request", () => {
  const { event } = createInput({ workflowRun: { pull_requests: [] } });

  assert.equal(pullRequestNumber(event), null);
});

test("rejects an outdated source head", () => {
  const { event, pullRequest } = createInput({
    pullRequest: {
      head: { sha: "new-head", repo: { full_name: "dGkdu/ldb" } },
    },
  });

  assert.equal(
    evaluateTrustedReviewRequest(event, pullRequest).reason,
    "stale_head",
  );
});

test("revalidates fork exclusion inside the trusted workflow", () => {
  const { event, pullRequest } = createInput({
    pullRequest: {
      head: { sha: "head-sha", repo: { full_name: "outside/fork" } },
    },
  });

  assert.equal(evaluateTrustedReviewRequest(event, pullRequest).reason, "fork");
});
