import { formatDate } from '../format-date.mjs'

export const SNAPSHOT_MARKER = '<!-- ldb-agent-usage-snapshot:v1 -->'
const COMMENT_LIMIT = 65_536

const WARNINGS = new Set([
  'usage_missing',
  'context_missing',
  'invalid_usage',
  'duplicate_conflict',
  'truncated_log',
  'counter_mismatch',
  'descendant_missing',
  'scope_incomplete',
  'unsafe_metadata'
])
const ROLES = new Set(['main', 'subagent'])
const EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'unknown'
])
const SNAPSHOT_KEYS = [
  'schemaVersion',
  'repository',
  'issue',
  'pullRequest',
  'headSha',
  'period',
  'complete',
  'warnings',
  'agents'
]
const PERIOD_KEYS = ['startedAt', 'capturedAt']
const AGENT_KEYS = [
  'role',
  'agent',
  'model',
  'effort',
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'totalTokens'
]

function fail() {
  throw new Error('Invalid usage snapshot')
}

function enforceCommentLimit(body) {
  const isString = typeof body === 'string'
  const exceedsCommentLimit = isString && body.length > COMMENT_LIMIT
  if (exceedsCommentLimit) {
    const error = new Error("Usage snapshot comment exceeds GitHub's 65536 character limit")
    error.code = 'COMMENT_TOO_LONG'
    throw error
  }
  return body
}

function isObject(value) {
  const isNonNull = value !== null
  const isObjectType = typeof value === 'object'
  const isNotArray = !Array.isArray(value)
  const isPlainObject = isNonNull && isObjectType && isNotArray
  return isPlainObject
}

function hasKeys(value, expected) {
  const keys = Object.keys(value)
  const hasExpectedKeyCount = keys.length === expected.length
  const hasAllExpectedKeys = hasExpectedKeyCount && expected.every((key) => keys.includes(key))
  return hasExpectedKeyCount && hasAllExpectedKeys
}

function positiveInteger(value) {
  const isSafeInteger = Number.isSafeInteger(value)
  const isPositive = isSafeInteger && value > 0
  return isSafeInteger && isPositive
}

function tokenCount(value) {
  const isSafeInteger = Number.isSafeInteger(value)
  const isNonNegative = isSafeInteger && value >= 0
  return isSafeInteger && isNonNegative
}

function utcTimestamp(value) {
  if (typeof value !== 'string') {
    return false
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(value)
  if (!match || !Number.isFinite(Date.parse(value))) {
    return false
  }
  const date = new Date(value)
  const fields = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds()
  ]
  return fields.every((field, index) => field === Number(match[index + 1]))
}

function safeIdentifier(value, maximum, pattern) {
  const isString = typeof value === 'string'
  const isWithinMaximum = isString && value.length <= maximum
  const matchesPattern = isWithinMaximum && pattern.test(value)
  const isSafeIdentifier = isString && isWithinMaximum && matchesPattern
  return isSafeIdentifier
}

export function validateSnapshot(value) {
  try {
    if (!isObject(value) || !hasKeys(value, SNAPSHOT_KEYS) || value.schemaVersion !== 1) {
      fail()
    }
    if (!safeIdentifier(value.repository, 200, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)) {
      fail()
    }
    if (!positiveInteger(value.issue) || !positiveInteger(value.pullRequest)) {
      fail()
    }
    if (typeof value.headSha !== 'string' || !/^[a-fA-F0-9]{40}$/.test(value.headSha)) {
      fail()
    }
    if (!isObject(value.period) || !hasKeys(value.period, PERIOD_KEYS)) {
      fail()
    }
    if (!utcTimestamp(value.period.startedAt) || !utcTimestamp(value.period.capturedAt)) {
      fail()
    }
    if (Date.parse(value.period.startedAt) > Date.parse(value.period.capturedAt)) {
      fail()
    }
    if (typeof value.complete !== 'boolean' || !Array.isArray(value.warnings)) {
      fail()
    }
    if (
      value.warnings.length > WARNINGS.size ||
      new Set(value.warnings).size !== value.warnings.length
    ) {
      fail()
    }
    if (!value.warnings.every((warning) => WARNINGS.has(warning))) {
      fail()
    }
    if (value.complete !== (value.warnings.length === 0)) {
      fail()
    }
    if (!Array.isArray(value.agents) || value.agents.length > 256) {
      fail()
    }

    const tuples = new Set()
    const agents = value.agents.map((agent) => {
      if (!isObject(agent) || !hasKeys(agent, AGENT_KEYS) || !ROLES.has(agent.role)) {
        fail()
      }
      if (!safeIdentifier(agent.agent, 64, /^[A-Za-z0-9][A-Za-z0-9_-]*$/)) {
        fail()
      }
      if (agent.model !== 'unknown' && !safeIdentifier(agent.model, 80, /^[A-Za-z0-9._:-]+$/)) {
        fail()
      }
      if (!EFFORTS.has(agent.effort)) {
        fail()
      }
      if (!AGENT_KEYS.slice(4).every((key) => tokenCount(agent[key]))) {
        fail()
      }
      if (agent.cachedInputTokens > agent.inputTokens) {
        fail()
      }
      if (agent.reasoningOutputTokens > agent.outputTokens) {
        fail()
      }
      if (agent.totalTokens !== agent.inputTokens + agent.outputTokens) {
        fail()
      }
      if (value.complete && (agent.model === 'unknown' || agent.effort === 'unknown')) {
        fail()
      }
      const tuple = `${agent.role}\0${agent.agent}\0${agent.model}\0${agent.effort}`
      if (tuples.has(tuple)) {
        fail()
      }
      tuples.add(tuple)
      return Object.fromEntries(AGENT_KEYS.map((key) => [key, agent[key]]))
    })
    for (const key of AGENT_KEYS.slice(4)) {
      if (!Number.isSafeInteger(agents.reduce((sum, agent) => sum + agent[key], 0))) {
        fail()
      }
    }
    if (value.complete && !agents.some(({ role }) => role === 'main')) {
      fail()
    }

    return {
      schemaVersion: 1,
      repository: value.repository,
      issue: value.issue,
      pullRequest: value.pullRequest,
      headSha: value.headSha.toLowerCase(),
      period: { startedAt: value.period.startedAt, capturedAt: value.period.capturedAt },
      complete: value.complete,
      warnings: [...value.warnings],
      agents
    }
  } catch {
    fail()
  }
}

function totals(agents) {
  const result = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  }
  for (const agent of agents) {
    for (const key of Object.keys(result)) {
      result[key] += agent[key]
    }
  }
  return result
}

function row(label, usage) {
  return `| ${label} | ${usage.inputTokens} | ${usage.cachedInputTokens} | ${usage.outputTokens} | ${usage.reasoningOutputTokens} | ${usage.totalTokens} | ${usage.totalTokens - usage.cachedInputTokens} |`
}

function roleRow(label, agents, complete) {
  if (!complete && agents.length === 0) {
    return `| ${label} | 미관측 | 미관측 | 미관측 | 미관측 | 미관측 | 미관측 |`
  }
  return row(label, totals(agents))
}

export function renderReport(value) {
  const snapshot = validateSnapshot(value)
  const startedAt = formatDate(snapshot.period.startedAt)
  const capturedAt = formatDate(snapshot.period.capturedAt)
  const status = snapshot.complete ? '완전' : `부분 관측 (${snapshot.warnings.join(', ')})`
  const main = snapshot.agents.filter(({ role }) => role === 'main')
  const subagents = snapshot.agents.filter(({ role }) => role === 'subagent')
  const usage = snapshot.agents.length
    ? [
        'Reasoning output은 output의 부분집합이며 total에 별도로 더하지 않았습니다.',
        '',
        '| 구분 | 입력 | 캐시 입력 | 출력 | Reasoning output | 전체 | 캐시 입력 제외 |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        roleRow('본 에이전트', main, snapshot.complete),
        roleRow('서브 에이전트', subagents, snapshot.complete),
        row('전체', totals(snapshot.agents)),
        '',
        '| Agent / model / effort | 입력 | 캐시 입력 | 출력 | Reasoning output | 전체 | 캐시 입력 제외 |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...snapshot.agents.map((agent) =>
          row(`${agent.role} / ${agent.agent} / ${agent.model} / ${agent.effort}`, agent)
        )
      ]
    : ['관측된 usage record가 없습니다. Token 수치를 추정하지 않았습니다.']

  return [
    '## Agent 사용량 보고',
    '',
    `- PR #${snapshot.pullRequest}`,
    `- 집계 범위: ${startedAt} ~ ${capturedAt}`,
    `- 상태: ${status}`,
    `- 기준 head: \`${snapshot.headSha}\``,
    '',
    ...usage
  ].join('\n')
}

export function snapshotComment(value) {
  const snapshot = validateSnapshot(value)
  return enforceCommentLimit(
    [
      SNAPSHOT_MARKER,
      renderReport(snapshot),
      '',
      '<details><summary>검증용 snapshot JSON</summary>',
      '',
      '```json',
      JSON.stringify(snapshot, null, 2),
      '```',
      '</details>'
    ].join('\n')
  )
}

export function parseSnapshotComment(body) {
  enforceCommentLimit(body)
  try {
    if (typeof body !== 'string' || !body.includes(SNAPSHOT_MARKER)) {
      fail()
    }
    const match = body.match(/```json\s*\n([\s\S]*?)\n```/)
    if (!match) {
      fail()
    }
    return validateSnapshot(JSON.parse(match[1]))
  } catch {
    fail()
  }
}
