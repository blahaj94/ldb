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
  const isNonArrayObject = isNonNull && isObjectType && isNotArray
  return isNonArrayObject
}

function hasKeys(value, expected) {
  const keys = Object.keys(value)
  const hasExpectedKeyCount = keys.length === expected.length
  const hasAllExpectedKeys = hasExpectedKeyCount && expected.every((key) => keys.includes(key))
  const hasExpectedKeys = hasExpectedKeyCount && hasAllExpectedKeys
  return hasExpectedKeys
}

function positiveInteger(value) {
  const isSafeInteger = Number.isSafeInteger(value)
  const isPositive = isSafeInteger && value > 0
  const isPositiveInteger = isSafeInteger && isPositive
  return isPositiveInteger
}

function tokenCount(value) {
  const isSafeInteger = Number.isSafeInteger(value)
  const isNonNegative = isSafeInteger && value >= 0
  const isValidTokenCount = isSafeInteger && isNonNegative
  return isValidTokenCount
}

function utcTimestamp(value) {
  const isString = typeof value === 'string'
  if (!isString) {
    return false
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(value)
  const hasTimestampMatch = match != null
  const isParseableTimestamp = hasTimestampMatch && Number.isFinite(Date.parse(value))
  if (!isParseableTimestamp) {
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
  const hasMatchingCalendarFields = fields.every((field, index) => {
    const isMatchingField = field === Number(match[index + 1])
    return isMatchingField
  })
  return hasMatchingCalendarFields
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
    const isSnapshotObject = isObject(value)
    const hasSnapshotKeys = isSnapshotObject && hasKeys(value, SNAPSHOT_KEYS)
    const hasSupportedSchema = hasSnapshotKeys && value.schemaVersion === 1
    if (!hasSupportedSchema) {
      fail()
    }
    const isSafeRepository = safeIdentifier(
      value.repository,
      200,
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
    )
    if (!isSafeRepository) {
      fail()
    }
    const isIssueNumberValid = positiveInteger(value.issue)
    const areRequestNumbersValid = isIssueNumberValid && positiveInteger(value.pullRequest)
    if (!areRequestNumbersValid) {
      fail()
    }
    const isHeadShaString = typeof value.headSha === 'string'
    const isHeadShaValid = isHeadShaString && /^[a-fA-F0-9]{40}$/.test(value.headSha)
    if (!isHeadShaValid) {
      fail()
    }
    const isPeriodObject = isObject(value.period)
    const hasPeriodKeys = isPeriodObject && hasKeys(value.period, PERIOD_KEYS)
    if (!hasPeriodKeys) {
      fail()
    }
    const isStartTimestampValid = utcTimestamp(value.period.startedAt)
    const arePeriodTimestampsValid = isStartTimestampValid && utcTimestamp(value.period.capturedAt)
    if (!arePeriodTimestampsValid) {
      fail()
    }
    const isPeriodReversed =
      Date.parse(value.period.startedAt) > Date.parse(value.period.capturedAt)
    if (isPeriodReversed) {
      fail()
    }
    const isCompleteBoolean = typeof value.complete === 'boolean'
    const hasWarningArray = isCompleteBoolean && Array.isArray(value.warnings)
    if (!hasWarningArray) {
      fail()
    }
    const hasExcessiveWarnings = value.warnings.length > WARNINGS.size
    const hasDuplicateWarnings =
      !hasExcessiveWarnings && new Set(value.warnings).size !== value.warnings.length
    const hasInvalidWarningList = hasExcessiveWarnings || hasDuplicateWarnings
    if (hasInvalidWarningList) {
      fail()
    }
    const hasKnownWarnings = value.warnings.every((warning) => {
      const isKnownWarning = WARNINGS.has(warning)
      return isKnownWarning
    })
    if (!hasKnownWarnings) {
      fail()
    }
    const complete = value.complete
    const hasNoWarnings = value.warnings.length === 0
    const isCompleteConsistent = complete === hasNoWarnings
    if (!isCompleteConsistent) {
      fail()
    }
    const isAgentArray = Array.isArray(value.agents)
    const hasExcessiveAgents = isAgentArray && value.agents.length > 256
    const isAgentListInvalid = !isAgentArray || hasExcessiveAgents
    if (isAgentListInvalid) {
      fail()
    }

    const tuples = new Set()
    const agents = value.agents.map((agent) => {
      const isAgentObject = isObject(agent)
      const hasAgentKeys = isAgentObject && hasKeys(agent, AGENT_KEYS)
      const hasKnownRole = hasAgentKeys && ROLES.has(agent.role)
      if (!hasKnownRole) {
        fail()
      }
      const isAgentIdentifierSafe = safeIdentifier(agent.agent, 64, /^[A-Za-z0-9][A-Za-z0-9_-]*$/)
      if (!isAgentIdentifierSafe) {
        fail()
      }
      const isModelReported = agent.model !== 'unknown'
      const isModelUnsafe =
        isModelReported && !safeIdentifier(agent.model, 80, /^[A-Za-z0-9._:-]+$/)
      if (isModelUnsafe) {
        fail()
      }
      const hasKnownEffort = EFFORTS.has(agent.effort)
      if (!hasKnownEffort) {
        fail()
      }
      const hasValidTokenCounts = AGENT_KEYS.slice(4).every((key) => {
        const isTokenCountValid = tokenCount(agent[key])
        return isTokenCountValid
      })
      if (!hasValidTokenCounts) {
        fail()
      }
      const hasExcessiveCachedTokens = agent.cachedInputTokens > agent.inputTokens
      if (hasExcessiveCachedTokens) {
        fail()
      }
      const hasExcessiveReasoningTokens = agent.reasoningOutputTokens > agent.outputTokens
      if (hasExcessiveReasoningTokens) {
        fail()
      }
      const hasInconsistentTotal = agent.totalTokens !== agent.inputTokens + agent.outputTokens
      if (hasInconsistentTotal) {
        fail()
      }
      // 앞서 읽은 값을 재사용하지 않고 기존 검증 단계에서 getter를 다시 읽는다.
      const requiresKnownContext = value.complete
      const isModelUnknown = requiresKnownContext && agent.model === 'unknown'
      const isEffortUnknown = requiresKnownContext && !isModelUnknown && agent.effort === 'unknown'
      const isRequiredContextMissing = isModelUnknown || isEffortUnknown
      if (isRequiredContextMissing) {
        fail()
      }
      const tuple = `${agent.role}\0${agent.agent}\0${agent.model}\0${agent.effort}`
      const isDuplicateAgent = tuples.has(tuple)
      if (isDuplicateAgent) {
        fail()
      }
      tuples.add(tuple)
      return Object.fromEntries(AGENT_KEYS.map((key) => [key, agent[key]]))
    })
    for (const key of AGENT_KEYS.slice(4)) {
      const isAggregateSafe = Number.isSafeInteger(
        agents.reduce((sum, agent) => sum + agent[key], 0)
      )
      if (!isAggregateSafe) {
        fail()
      }
    }
    const isMainAgentRequired = value.complete
    const isRequiredMainAgentMissing =
      isMainAgentRequired && !agents.some(({ role }) => role === 'main')
    if (isRequiredMainAgentMissing) {
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
  const isIncomplete = !complete
  const isRoleUnobserved = isIncomplete && agents.length === 0
  if (isRoleUnobserved) {
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
  const hasObservedAgents = snapshot.agents.length > 0
  const usage = hasObservedAgents
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

  const reportBody = [
    '## Agent 사용량 보고',
    '',
    `- PR #${snapshot.pullRequest}`,
    `- 집계 범위: ${startedAt} ~ ${capturedAt}`,
    `- 상태: ${status}`,
    `- 기준 head: \`${snapshot.headSha}\``,
    '',
    ...usage
  ].join('\n')
  return reportBody
}

export function snapshotComment(value) {
  const snapshot = validateSnapshot(value)
  const commentBody = [
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
  return enforceCommentLimit(commentBody)
}

export function parseSnapshotComment(body) {
  enforceCommentLimit(body)
  try {
    const isBodyString = typeof body === 'string'
    const hasSnapshotMarker = isBodyString && body.includes(SNAPSHOT_MARKER)
    if (!hasSnapshotMarker) {
      fail()
    }
    const match = body.match(/```json\s*\n([\s\S]*?)\n```/)
    const hasSnapshotJson = match != null
    if (!hasSnapshotJson) {
      fail()
    }
    return validateSnapshot(JSON.parse(match[1]))
  } catch {
    fail()
  }
}
