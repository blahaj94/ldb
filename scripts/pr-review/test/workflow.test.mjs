import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "../../../.github/workflows/ai-pr-review.yml",
  import.meta.url,
);

test("workflow is label-gated, advisory, and excludes privileged PR targets", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /labeled/);
  assert.match(workflow, /@ldb-review/);
  assert.match(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /secrets\./);
});
