import assert from "node:assert/strict";
import test from "node:test";

import { buildPolicyReport } from "../src/policy.mjs";

function statusFor(report, name) {
  return report.checks.find((check) => check.name === name)?.status;
}

function createInput(overrides = {}) {
  return {
    pullRequest: { body: "Related to #2" },
    repositoryOwner: "blahaj94",
    files: [
      { filename: "src/service.ts", additions: 20, deletions: 5 },
      { filename: "src/service.test.ts", additions: 30, deletions: 0 },
    ],
    commits: [
      { commit: { message: "test: cover service behavior" } },
      { commit: { message: "feat: implement service behavior" } },
    ],
    comments: [],
    ...overrides,
  };
}

test("passes linked Issue and Red-before-Green evidence", () => {
  const report = buildPolicyReport(createInput());

  assert.equal(statusFor(report, "linked_issue"), "pass");
  assert.equal(statusFor(report, "test_evidence"), "pass");
  assert.equal(statusFor(report, "logic_budget"), "pass");
});

test("warns when logic changes do not have a Red test commit", () => {
  const report = buildPolicyReport(
    createInput({
      commits: [{ commit: { message: "feat: implement service behavior" } }],
    }),
  );

  assert.equal(statusFor(report, "test_evidence"), "warning");
});

test("warns when implementation precedes the Red test commit", () => {
  const report = buildPolicyReport(
    createInput({
      commits: [
        { commit: { message: "feat: implement service behavior" } },
        { commit: { message: "test: cover service behavior" } },
      ],
    }),
  );

  assert.equal(statusFor(report, "test_evidence"), "warning");
});

test("warns when Rule changes do not have owner approval", () => {
  const report = buildPolicyReport(
    createInput({
      files: [{ filename: "AGENTS.md", additions: 2, deletions: 1 }],
      commits: [{ commit: { message: "docs: adjust agent rule" } }],
    }),
  );

  assert.equal(statusFor(report, "rule_approval"), "warning");
});

test("accepts an exact owner approval for Rule changes", () => {
  const report = buildPolicyReport(
    createInput({
      files: [{ filename: "docs/rules/testing.md", additions: 2, deletions: 1 }],
      commits: [{ commit: { message: "docs: adjust testing rule" } }],
      comments: [{ body: "승인", user: { login: "blahaj94" } }],
    }),
  );

  assert.equal(statusFor(report, "rule_approval"), "pass");
});

test("warns when the approximate logic diff exceeds 300 lines", () => {
  const report = buildPolicyReport(
    createInput({
      files: [{ filename: "src/service.ts", additions: 250, deletions: 75 }],
    }),
  );

  assert.equal(statusFor(report, "logic_budget"), "warning");
});

test("applies the logic budget to each commit instead of the whole PR", () => {
  const report = buildPolicyReport(
    createInput({
      files: [
        { filename: "src/first.ts", additions: 200, deletions: 0 },
        { filename: "src/second.ts", additions: 200, deletions: 0 },
      ],
      commitFiles: [
        {
          sha: "first",
          files: [{ filename: "src/first.ts", additions: 200, deletions: 0 }],
        },
        {
          sha: "second",
          files: [{ filename: "src/second.ts", additions: 200, deletions: 0 }],
        },
      ],
    }),
  );

  assert.equal(statusFor(report, "logic_budget"), "pass");
});
