import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const fields = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens'
]
const names = [
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'totalTokens'
]
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/

export async function catalogSessions(directory) {
  const catalog = new Map()
  for (const relative of (await readdir(directory, { recursive: true })).sort()) {
    const isSessionFile = relative.endsWith('.jsonl')
    if (!isSessionFile) {
      continue
    }
    const file = join(directory, relative)
    const stream = createReadStream(file, { encoding: 'utf8' })
    try {
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        const event = JSON.parse(line)
        const isSessionMetadata = event.type === 'session_meta'
        const hasStringId = isSessionMetadata && typeof event.payload?.id === 'string'
        if (!hasStringId) {
          break
        }
        const meta = event.payload
        const spawn = meta.source?.subagent?.thread_spawn
        const hasDuplicateId = catalog.has(meta.id)
        if (hasDuplicateId) {
          catalog.get(meta.id).duplicate = true
        } else {
          const hasSpawnMetadata = spawn != null && spawn !== false && spawn !== 0 && spawn !== ''
          catalog.set(meta.id, {
            id: meta.id,
            file,
            parent: meta.parent_thread_id ?? spawn?.parent_thread_id ?? null,
            agentPath: spawn?.agent_path ?? (hasSpawnMetadata ? null : '/root')
          })
        }
        break
      }
    } catch {
      // 식별할 수 없는 file은 대상/descendant 존재 검증에서 누락으로 처리한다.
    } finally {
      stream.destroy()
    }
  }
  return catalog
}

export async function readSession(file, until = new Date().toISOString()) {
  const result = {
    turns: [],
    contexts: new Map(),
    records: [],
    expected: [],
    done: new Set(),
    truncated: false
  }
  const turns = new Map()
  const calls = new Map()
  let currentTurn
  const addTurn = (id, timestamp) => {
    const isTurnIdString = typeof id === 'string'
    const isKnownTurn = isTurnIdString && turns.has(id)
    const shouldSkipTurn = !isTurnIdString || isKnownTurn
    if (shouldSkipTurn) {
      return
    }
    const turn = { id, timestamp }
    turns.set(id, turn)
    result.turns.push(turn)
  }
  const stream = createReadStream(file, { encoding: 'utf8' })
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      const isEmptyLine = line.trim().length === 0
      if (isEmptyLine) {
        continue
      }
      let event
      try {
        event = JSON.parse(line)
      } catch {
        result.truncated = true
        continue
      }
      const timestamp = event.timestamp
      const isTimestampAbsent =
        timestamp == null || timestamp === '' || timestamp === false || timestamp === 0
      const isAfterCutoff = !isTimestampAbsent && Date.parse(event.timestamp) > Date.parse(until)
      const shouldSkipEvent = isTimestampAbsent || isAfterCutoff
      if (shouldSkipEvent) {
        continue
      }
      const p = event.payload ?? {}
      const isTurnContext = event.type === 'turn_context'
      const isStartEventMessage = !isTurnContext && event.type === 'event_msg'
      const isTaskStarted = isStartEventMessage && p.type === 'task_started'
      const startsTurn = isTurnContext || isTaskStarted
      if (startsTurn) {
        currentTurn = p.turn_id
        addTurn(currentTurn, event.timestamp)
        const hasTurnContext = event.type === 'turn_context'
        if (hasTurnContext) {
          result.contexts.set(currentTurn, { model: p.model, effort: p.effort })
        }
      }
      const isCompletionEventMessage = event.type === 'event_msg'
      const isTaskComplete = isCompletionEventMessage && p.type === 'task_complete'
      if (isTaskComplete) {
        result.done.add(p.turn_id)
      }
      const isUsageRecord = event.type === 'token_usage_record'
      if (isUsageRecord) {
        addTurn(p.turn_id, event.timestamp)
        result.records.push({ ...p, context: result.contexts.get(p.turn_id) })
      }
      const isResponseItem = event.type === 'response_item'
      if (!isResponseItem) {
        continue
      }
      const isFunctionCall = p.type === 'function_call'
      const isAgentCall = isFunctionCall && ['spawn_agent', 'followup_task'].includes(p.name)
      if (isAgentCall) {
        calls.set(p.call_id, { name: p.name, turn: currentTurn })
        const isFollowupCall = p.name === 'followup_task'
        if (isFollowupCall) {
          try {
            const target = JSON.parse(p.arguments).target
            const isTargetString = typeof target === 'string'
            if (isTargetString) {
              result.expected.push({ turn: currentTurn, target })
            }
          } catch {
            /* 실패한 tool call은 새 descendant의 존재 증거가 아니다. */
          }
        }
      }
      const isFunctionOutput = p.type === 'function_call_output'
      const isSpawnOutput = isFunctionOutput && calls.get(p.call_id)?.name === 'spawn_agent'
      if (isSpawnOutput) {
        try {
          const isOutputJson = typeof p.output === 'string'
          const output = isOutputJson ? JSON.parse(p.output) : p.output
          const hasTaskName = typeof output?.task_name === 'string'
          if (hasTaskName) {
            result.expected.push({ turn: calls.get(p.call_id).turn, target: output.task_name })
          }
        } catch {
          /* error text와 원문은 보관하지 않는다. */
        }
      }
    }
  } finally {
    stream.destroy()
  }
  return result
}

function validUsage(value) {
  const isFalsyValue =
    value == null ||
    value === false ||
    value === 0 ||
    value === 0n ||
    value === '' ||
    Number.isNaN(value)
  // 기존 guard가 반환하던 falsy 값 자체를 유지한다.
  if (isFalsyValue) {
    return value
  }
  const hasValidCounters = fields.every((key) => {
    const isSafeInteger = Number.isSafeInteger(value[key])
    const isValidCounter = isSafeInteger && value[key] >= 0
    return isValidCounter
  })
  const hasValidCachedCount = hasValidCounters && value.cached_input_tokens <= value.input_tokens
  const hasValidReasoningCount =
    hasValidCachedCount && value.reasoning_output_tokens <= value.output_tokens
  const hasConsistentTotal =
    hasValidReasoningCount && value.total_tokens === value.input_tokens + value.output_tokens
  return hasConsistentTotal
}

export async function collectUsage(
  directory,
  { thread, fromTurn, throughTurn, excludeTurns = [], until = new Date().toISOString() }
) {
  const isCutoffValid = Number.isFinite(Date.parse(until))
  if (!isCutoffValid) {
    throw new Error('유효한 집계 종료 시각이 필요합니다.')
  }
  const catalog = await catalogSessions(directory)
  const root = catalog.get(thread)
  const hasRoot = root != null
  const parent = hasRoot ? root.parent : null
  const hasRootParent = parent != null && parent !== false && parent !== 0 && parent !== ''
  const isRootInvalid = !hasRoot || hasRootParent
  if (isRootInvalid) {
    throw new Error('Root task log를 확인할 수 없습니다.')
  }
  const rootLog = await readSession(root.file, until)
  const first = rootLog.turns.findIndex((turn) => turn.id === fromTurn)
  const hasThroughTurn =
    throughTurn != null &&
    throughTurn !== '' &&
    throughTurn !== false &&
    throughTurn !== 0 &&
    throughTurn !== 0n &&
    !Number.isNaN(throughTurn)
  const last = hasThroughTurn
    ? rootLog.turns.findIndex((turn) => turn.id === throughTurn)
    : rootLog.turns.length - 1
  const isStartMissing = first < 0
  const isRangeReversed = !isStartMissing && last < first
  const hasUnknownExclusion =
    !isStartMissing &&
    !isRangeReversed &&
    excludeTurns.some((id) => {
      const isKnownTurn = rootLog.turns.some((turn) => turn.id === id)
      return !isKnownTurn
    })
  const isRangeInvalid = isStartMissing || isRangeReversed || hasUnknownExclusion
  if (isRangeInvalid) {
    throw new Error('명시한 시작/종료/제외 turn 범위를 확인할 수 없습니다.')
  }
  const selected = new Set(
    rootLog.turns
      .slice(first, last + 1)
      .map((turn) => turn.id)
      .filter((id) => !excludeTurns.includes(id))
  )
  const hasSelectedTurns = selected.size > 0
  if (!hasSelectedTurns) {
    throw new Error('집계 대상 turn이 없습니다.')
  }
  const family = [root]
  const visited = new Set([thread])
  for (let index = 0; index < family.length; index++) {
    for (const meta of catalog.values()) {
      const isDirectChild = meta.parent === family[index].id
      const isUnvisitedChild = isDirectChild && !visited.has(meta.id)
      if (isUnvisitedChild) {
        family.push(meta)
        visited.add(meta.id)
      }
    }
  }
  const warnings = new Set()
  const agents = []
  let childIndex = 0
  for (const meta of family) {
    const isRoot = meta === root
    const log = isRoot ? rootLog : await readSession(meta.file, until)
    const inScope = (p) => {
      const isRecordInScope = selected.has(isRoot ? p.turn_id : p.root_turn_id)
      return isRecordInScope
    }
    const selectedTurns = new Set(log.records.filter(inScope).map((p) => p.turn_id))
    if (isRoot) {
      for (const id of selected) {
        selectedTurns.add(id)
      }
    }
    const isExpected = isRoot || log.records.some(inScope)
    if (!isExpected) {
      continue
    }
    if (log.truncated) {
      warnings.add('truncated_log')
    }
    const isDuplicateSession = meta.duplicate === true
    if (isDuplicateSession) {
      warnings.add('duplicate_conflict')
    }
    const role = isRoot ? 'main' : 'subagent'
    const task = meta.agentPath?.split('/').at(-1)
    const isTaskNameSafe = /^[a-zA-Z0-9_-]{1,40}$/.test(task ?? '')
    const safeTask = isTaskNameSafe ? task : 'unknown'
    const agent = isRoot ? 'main' : `subagent_${++childIndex}_${safeTask}`
    const isSubagentMetadataUnsafe = !isRoot && safeTask === 'unknown'
    if (isSubagentMetadataUnsafe) {
      warnings.add('unsafe_metadata')
    }
    for (const expected of log.expected.filter((entry) => selectedTurns.has(entry.turn))) {
      const isAbsoluteTarget = expected.target.startsWith('/')
      const path = isAbsoluteTarget ? expected.target : `${meta.agentPath}/${expected.target}`
      const child =
        family.find((entry) => entry.id === expected.target) ??
        family.find((entry) => entry.agentPath === path)
      const hasChild = child != null
      if (!hasChild) {
        warnings.add('descendant_missing')
      } else {
        const childLog = await readSession(child.file, until)
        const hasChildUsage = childLog.records.some((p) => selected.has(p.root_turn_id))
        if (!hasChildUsage) {
          warnings.add('usage_missing')
        }
      }
    }
    const seen = new Map()
    const rows = new Map()
    const sums = Object.fromEntries(fields.map((key) => [key, 0]))
    let cumulative
    const observedTurns = new Set()
    for (const record of log.records) {
      const relevant = inScope(record)
      const hasMatchingThread = record.thread_id === meta.id
      const turnId = hasMatchingThread ? record.turn_id : undefined
      const hasTurnId = turnId != null && turnId !== '' && turnId !== false && turnId !== 0
      const responseId = hasTurnId ? record.response_id : undefined
      const hasResponseId =
        responseId != null && responseId !== '' && responseId !== false && responseId !== 0
      const isUsageInvalid = hasResponseId && !validUsage(record.usage)
      const isRecordInvalid = !hasMatchingThread || !hasTurnId || !hasResponseId || isUsageInvalid
      if (isRecordInvalid) {
        if (relevant) {
          warnings.add('invalid_usage')
        }
        continue
      }
      const key = JSON.stringify([record.thread_id, record.turn_id, record.response_id])
      const isDuplicateRecord = seen.has(key)
      if (isDuplicateRecord) {
        const hasCounterConflict = fields.some((field) => {
          const isCounterDifferent = seen.get(key)[field] !== record.usage[field]
          return isCounterDifferent
        })
        const isRelevantConflict = hasCounterConflict && relevant
        if (isRelevantConflict) {
          warnings.add('duplicate_conflict')
        }
        continue
      }
      seen.set(key, record.usage)
      for (const field of fields) {
        sums[field] += record.usage[field]
      }
      const threadUsage = record.thread_token_usage
      const hasThreadUsage =
        threadUsage != null && threadUsage !== '' && threadUsage !== false && threadUsage !== 0
      if (hasThreadUsage) {
        cumulative = record.thread_token_usage
      }
      if (!relevant) {
        continue
      }
      observedTurns.add(record.turn_id)
      const context = record.context ?? log.contexts.get(record.turn_id)
      const isModelIdentifierSafe = identifier.test(context?.model ?? '')
      const model = isModelIdentifierSafe ? context.model : 'unknown'
      const isEffortKnown = efforts.has(context?.effort)
      const effort = isEffortKnown ? context.effort : 'unknown'
      const isModelUnknown = model === 'unknown'
      const isEffortUnknown = effort === 'unknown'
      const isContextMissing = isModelUnknown || isEffortUnknown
      if (isContextMissing) {
        warnings.add('context_missing')
      }
      const group = JSON.stringify([model, effort])
      const hasGroupRow = rows.has(group)
      if (!hasGroupRow) {
        rows.set(group, {
          role,
          agent,
          model,
          effort,
          ...Object.fromEntries(names.map((name) => [name, 0]))
        })
      }
      const row = rows.get(group)
      fields.forEach((field, index) => {
        row[names[index]] += record.usage[field]
      })
    }
    const hasSelectedTurns = selectedTurns.size > 0
    const hasUnobservedTurns =
      hasSelectedTurns && [...selectedTurns].some((turn) => !observedTurns.has(turn))
    if (hasUnobservedTurns) {
      warnings.add('usage_missing')
    }
    const hasUnfinishedChildTurns =
      !isRoot && [...selectedTurns].some((turn) => !log.done.has(turn))
    if (hasUnfinishedChildTurns) {
      warnings.add('scope_incomplete')
    }
    const hasCumulativeUsage =
      cumulative != null && cumulative !== '' && cumulative !== false && cumulative !== 0
    const hasCounterMismatch =
      hasCumulativeUsage &&
      fields.some((field) => {
        const isCounterDifferent = cumulative[field] !== sums[field]
        return isCounterDifferent
      })
    if (hasCounterMismatch) {
      warnings.add('counter_mismatch')
    }
    for (const row of rows.values()) {
      const hasSafeCounters = names.every((name) => {
        const isCounterSafe = Number.isSafeInteger(row[name])
        return isCounterSafe
      })
      if (hasSafeCounters) {
        agents.push(row)
      } else {
        warnings.add('invalid_usage')
      }
    }
  }
  const isComplete = warnings.size === 0
  return {
    period: {
      startedAt: rootLog.turns[first].timestamp,
      capturedAt: new Date(until).toISOString()
    },
    complete: isComplete,
    warnings: [...warnings].sort(),
    agents
  }
}
