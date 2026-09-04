export const SNAPSHOT_MARKER = "<!-- ldb-agent-usage-snapshot:v1 -->";

const WARNINGS = new Set([
  "usage_missing",
  "context_missing",
  "invalid_usage",
  "duplicate_conflict",
  "truncated_log",
  "counter_mismatch",
  "descendant_missing",
  "scope_incomplete",
  "unsafe_metadata",
]);
const ROLES = new Set(["main", "subagent"]);
const EFFORTS = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown",
]);
const SNAPSHOT_KEYS = [
  "schemaVersion", "repository", "issue", "pullRequest", "headSha", "period", "complete",
  "warnings", "agents",
];
const PERIOD_KEYS = ["startedAt", "capturedAt"];
const AGENT_KEYS = [
  "role", "agent", "model", "effort", "inputTokens", "cachedInputTokens", "outputTokens",
  "reasoningOutputTokens", "totalTokens",
];

function fail() {
  throw new Error("Invalid usage snapshot");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function utcTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function safeIdentifier(value, maximum, pattern) {
  return typeof value === "string" && value.length <= maximum && pattern.test(value);
}

export function validateSnapshot(value) {
  try {
    if (!isObject(value) || !hasKeys(value, SNAPSHOT_KEYS) || value.schemaVersion !== 1) fail();
    if (!safeIdentifier(value.repository, 200, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)) fail();
    if (!positiveInteger(value.issue) || !positiveInteger(value.pullRequest)) fail();
    if (typeof value.headSha !== "string" || !/^[a-fA-F0-9]{40}$/.test(value.headSha)) fail();
    if (!isObject(value.period) || !hasKeys(value.period, PERIOD_KEYS)) fail();
    if (!utcTimestamp(value.period.startedAt) || !utcTimestamp(value.period.capturedAt)) fail();
    if (Date.parse(value.period.startedAt) > Date.parse(value.period.capturedAt)) fail();
    if (typeof value.complete !== "boolean" || !Array.isArray(value.warnings)) fail();
    if (value.warnings.length > WARNINGS.size || new Set(value.warnings).size !== value.warnings.length) fail();
    if (!value.warnings.every((warning) => WARNINGS.has(warning))) fail();
    if (value.complete !== (value.warnings.length === 0)) fail();
    if (!Array.isArray(value.agents) || value.agents.length > 256) fail();

    const tuples = new Set();
    const agents = value.agents.map((agent) => {
      if (!isObject(agent) || !hasKeys(agent, AGENT_KEYS) || !ROLES.has(agent.role)) fail();
      if (!safeIdentifier(agent.agent, 64, /^[A-Za-z0-9][A-Za-z0-9_-]*$/)) fail();
      if (agent.model !== "unknown" && !safeIdentifier(agent.model, 80, /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/)) fail();
      if (!EFFORTS.has(agent.effort)) fail();
      if (!AGENT_KEYS.slice(4).every((key) => tokenCount(agent[key]))) fail();
      if (agent.cachedInputTokens > agent.inputTokens) fail();
      if (agent.reasoningOutputTokens > agent.outputTokens) fail();
      if (agent.totalTokens !== agent.inputTokens + agent.outputTokens) fail();
      if (value.complete && (agent.model === "unknown" || agent.effort === "unknown")) fail();
      const tuple = `${agent.role}\0${agent.agent}\0${agent.model}\0${agent.effort}`;
      if (tuples.has(tuple)) fail();
      tuples.add(tuple);
      return Object.fromEntries(AGENT_KEYS.map((key) => [key, agent[key]]));
    });

    return {
      schemaVersion: 1,
      repository: value.repository,
      issue: value.issue,
      pullRequest: value.pullRequest,
      headSha: value.headSha.toLowerCase(),
      period: { startedAt: value.period.startedAt, capturedAt: value.period.capturedAt },
      complete: value.complete,
      warnings: [...value.warnings],
      agents,
    };
  } catch {
    fail();
  }
}

function totals(agents) {
  const result = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  for (const agent of agents) {
    for (const key of Object.keys(result)) result[key] += agent[key];
  }
  return result;
}

function row(label, usage) {
  return `| ${label} | ${usage.inputTokens} | ${usage.cachedInputTokens} | ${usage.outputTokens} | ${usage.reasoningOutputTokens} | ${usage.totalTokens} | ${usage.totalTokens - usage.cachedInputTokens} |`;
}

export function renderReport(value) {
  const snapshot = validateSnapshot(value);
  const status = snapshot.complete
    ? "완전"
    : `부분 관측 (${snapshot.warnings.join(", ")})`;
  const usage = snapshot.agents.length ? [
    "Reasoning output은 output의 부분집합이며 total에 별도로 더하지 않았습니다.",
    "",
    "| 구분 | 입력 | 캐시 입력 | 출력 | Reasoning output | 전체 | 캐시 입력 제외 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    row("본 에이전트", totals(snapshot.agents.filter(({ role }) => role === "main"))),
    row("서브 에이전트", totals(snapshot.agents.filter(({ role }) => role === "subagent"))),
    row("전체", totals(snapshot.agents)),
    "",
    "| Agent / model / effort | 입력 | 캐시 입력 | 출력 | Reasoning output | 전체 | 캐시 입력 제외 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...snapshot.agents.map((agent) => row(`${agent.role} / ${agent.agent} / ${agent.model} / ${agent.effort}`, agent)),
  ] : ["관측된 usage record가 없습니다. Token 수치를 추정하지 않았습니다."];

  return [
    "## Agent 사용량 보고",
    "",
    `- PR #${snapshot.pullRequest}`,
    `- 집계 범위: ${snapshot.period.startedAt} ~ ${snapshot.period.capturedAt}`,
    `- 상태: ${status}`,
    `- 기준 head: \`${snapshot.headSha}\``,
    "",
    ...usage,
  ].join("\n");
}

export function snapshotComment(value) {
  const snapshot = validateSnapshot(value);
  return [
    SNAPSHOT_MARKER,
    renderReport(snapshot),
    "",
    "<details><summary>검증용 snapshot JSON</summary>",
    "",
    "```json",
    JSON.stringify(snapshot, null, 2),
    "```",
    "</details>",
  ].join("\n");
}

export function parseSnapshotComment(body) {
  try {
    if (typeof body !== "string" || body.length > 500_000 || !body.includes(SNAPSHOT_MARKER)) fail();
    const match = body.match(/```json\s*\n([\s\S]*?)\n```/);
    if (!match) fail();
    return validateSnapshot(JSON.parse(match[1]));
  } catch {
    fail();
  }
}
