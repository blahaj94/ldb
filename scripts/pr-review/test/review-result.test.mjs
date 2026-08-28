import assert from "node:assert/strict";
import test from "node:test";

import { validateReviewResult } from "../src/review-result.mjs";

test("accepts a normalized provider-neutral review result", () => {
  const result = validateReviewResult({
    headSha: "abc123",
    summary: "One consequential issue found.",
    findings: [
      {
        severity: "P1",
        confidence: 0.95,
        path: "src/service.ts",
        line: 12,
        evidence: "Authorization condition is reversed.",
        impact: "Private data is exposed.",
        suggestedAction: "Require requesterId to equal ownerId.",
      },
    ],
    missingContext: [],
  });

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("rejects malformed findings before publication", () => {
  const result = validateReviewResult({
    headSha: "abc123",
    summary: "Invalid result",
    findings: [{ severity: "critical", confidence: 2 }],
    missingContext: [],
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 2);
});
