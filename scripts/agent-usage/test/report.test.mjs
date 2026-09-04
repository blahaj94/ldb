import assert from "node:assert/strict";
import test from "node:test";

import {
  SNAPSHOT_MARKER,
  parseSnapshotComment,
  renderReport,
  snapshotComment,
  validateSnapshot,
} from "../report.mjs";

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    issue: 34,
    pullRequest: 35,
    headSha: "a".repeat(40),
    period: {
      startedAt: "2026-09-05T00:00:00.000Z",
      capturedAt: "2026-09-05T01:00:00.000Z",
    },
    complete: true,
    warnings: [],
    agents: [
      {
        role: "main",
        agent: "root",
        model: "gpt-5",
        effort: "high",
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 120,
      },
      {
        role: "subagent",
        agent: "publisher",
        model: "gpt-5-mini",
        effort: "medium",
        inputTokens: 50,
        cachedInputTokens: 10,
        outputTokens: 8,
        reasoningOutputTokens: 2,
        totalTokens: 58,
      },
    ],
    ...overrides,
  };
}

test("validateSnapshot returns a fresh allowlisted snapshot", () => {
  const source = snapshot();
  const result = validateSnapshot(source);
  assert.deepEqual(result, source);
  assert.notEqual(result, source);
  assert.notEqual(result.period, source.period);
  assert.notEqual(result.agents[0], source.agents[0]);
});

test("validateSnapshot accepts UTC ISO timestamps without fractional seconds", () => {
  const value = snapshot({
    period: {
      startedAt: "2026-09-05T00:00:00Z",
      capturedAt: "2026-09-05T01:00:00Z",
    },
  });
  assert.deepEqual(validateSnapshot(value).period, value.period);
});

test("validateSnapshot rejects unknown keys, unsafe strings, and excessive rows", () => {
  assert.throws(() => validateSnapshot({ ...snapshot(), secret: "no" }), /Invalid usage snapshot/);
  assert.throws(
    () => validateSnapshot(snapshot({ agents: [{ ...snapshot().agents[0], model: "x\n| bad" }] })),
    /Invalid usage snapshot/,
  );
  assert.throws(
    () => validateSnapshot(snapshot({ agents: Array(257).fill(snapshot().agents[0]) })),
    /Invalid usage snapshot/,
  );
});

test("validateSnapshot enforces token math and complete state", () => {
  const row = snapshot().agents[0];
  for (const invalid of [
    { ...row, cachedInputTokens: 101 },
    { ...row, reasoningOutputTokens: 21 },
    { ...row, totalTokens: 125 },
    { ...row, inputTokens: -1 },
  ]) {
    assert.throws(() => validateSnapshot(snapshot({ agents: [invalid] })), /Invalid usage snapshot/);
  }
  assert.throws(
    () => validateSnapshot(snapshot({ complete: true, warnings: ["usage_missing"] })),
    /Invalid usage snapshot/,
  );
  assert.throws(
    () => validateSnapshot(snapshot({ agents: [{ ...row, model: "unknown" }] })),
    /Invalid usage snapshot/,
  );
  assert.doesNotThrow(() =>
    validateSnapshot(snapshot({ complete: false, warnings: ["context_missing"], agents: [] })),
  );
});

test("validateSnapshot rejects aggregate counters that exceed safe integers", () => {
  const row = {
    ...snapshot().agents[0],
    inputTokens: Number.MAX_SAFE_INTEGER - 20,
    cachedInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 0,
    totalTokens: Number.MAX_SAFE_INTEGER,
  };
  assert.throws(
    () => validateSnapshot(snapshot({ agents: [row, { ...row, agent: "root-2" }] })),
    /Invalid usage snapshot/,
  );
});

test("snapshot comments round-trip only marked, validated JSON", () => {
  const value = snapshot();
  const body = snapshotComment(value);
  assert.match(body, new RegExp(SNAPSHOT_MARKER));
  assert.deepEqual(parseSnapshotComment(body), value);
  assert.throws(() => parseSnapshotComment(body.replace(SNAPSHOT_MARKER, "")), /Invalid/);
  assert.throws(
    () => parseSnapshotComment(body.replace('"schemaVersion": 1', '"schemaVersion": 2')),
    /Invalid/,
  );
});

test("renderReport shows Korean scope, role totals, counters, and partial status", () => {
  const body = renderReport(
    snapshot({ complete: false, warnings: ["scope_incomplete"] }),
  );
  assert.match(body, /PR #35/);
  assert.match(body, /집계 범위/);
  assert.match(body, /부분 관측/);
  assert.match(body, /본 에이전트/);
  assert.match(body, /서브 에이전트/);
  assert.match(body, /전체/);
  assert.match(body, /입력/);
  assert.match(body, /캐시 입력/);
  assert.match(body, /출력/);
  assert.match(body, /reasoning output/i);
  assert.match(body, /캐시 입력 제외/);
  assert.match(body, /178/);
  assert.match(body, /128/);
  assert.match(body, /publisher/);
  assert.match(body, /gpt-5-mini/);
  assert.match(body, /medium/);
});

test("renderReport does not infer zero totals when no records were observed", () => {
  const body = renderReport(snapshot({
    complete: false,
    warnings: ["usage_missing"],
    agents: [],
  }));
  assert.match(body, /관측된 usage record가 없습니다/);
  assert.doesNotMatch(body, /\|\s*0\s*\|/);
});
