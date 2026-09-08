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
  const hasMultipleValidationErrors = result.errors.length >= 2;
  assert.ok(hasMultipleValidationErrors);
});

test("preserves repeated line reads before accepting a boundary value", () => {
  let lineReads = 0;
  const finding = {
    severity: "P1",
    confidence: 0.95,
    path: "src/service.ts",
    line: 0,
    evidence: "Evidence",
    impact: "Impact",
    suggestedAction: "Action",
    get line() {
      lineReads += 1;
      const isFirstLineRead = lineReads === 1;
      return isFirstLineRead ? 1 : Number.NaN;
    },
  };

  const result = validateReviewResult({
    headSha: "abc123",
    summary: "Valid result",
    findings: [finding],
    missingContext: [],
  });

  assert.deepEqual(result, { valid: true, errors: [] });
  assert.equal(lineReads, 2);
});

test("preserves the order of accumulated validation errors", () => {
  const result = validateReviewResult({
    headSha: "",
    summary: 42,
    findings: [
      {
        severity: "critical",
        confidence: 2,
        path: "",
        evidence: "",
        impact: "",
        suggestedAction: "",
        line: 0,
      },
    ],
    missingContext: {},
  });

  assert.deepEqual(result.errors, [
    "headSha must be a non-empty string",
    "summary must be a string",
    "findings[0].severity is invalid",
    "findings[0].confidence must be between 0 and 1",
    "findings[0].path must be a non-empty string",
    "findings[0].evidence must be a non-empty string",
    "findings[0].impact must be a non-empty string",
    "findings[0].suggestedAction must be a non-empty string",
    "findings[0].line must be a positive integer",
    "missingContext must be an array",
  ]);
});
