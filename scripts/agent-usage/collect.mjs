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
    if (!relative.endsWith('.jsonl')) {
      continue
    }
    const file = join(directory, relative)
    const stream = createReadStream(file, { encoding: 'utf8' })
    try {
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        const event = JSON.parse(line)
        if (event.type !== 'session_meta' || typeof event.payload?.id !== 'string') {
          break
        }
        const meta = event.payload
        const spawn = meta.source?.subagent?.thread_spawn
        if (catalog.has(meta.id)) {
          catalog.get(meta.id).duplicate = true
        } else {
          catalog.set(meta.id, {
            id: meta.id,
            file,
            parent: meta.parent_thread_id ?? spawn?.parent_thread_id ?? null,
            agentPath: spawn?.agent_path ?? (spawn ? null : '/root')
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
    if (typeof id !== 'string' || turns.has(id)) {
      return
    }
    const turn = { id, timestamp }
    turns.set(id, turn)
    result.turns.push(turn)
  }
  const stream = createReadStream(file, { encoding: 'utf8' })
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      if (!line.trim()) {
        continue
      }
      let event
      try {
        event = JSON.parse(line)
      } catch {
        result.truncated = true
        continue
      }
      if (!event.timestamp || Date.parse(event.timestamp) > Date.parse(until)) {
        continue
      }
      const p = event.payload ?? {}
      if (
        event.type === 'turn_context' ||
        (event.type === 'event_msg' && p.type === 'task_started')
      ) {
        currentTurn = p.turn_id
        addTurn(currentTurn, event.timestamp)
        if (event.type === 'turn_context') {
          result.contexts.set(currentTurn, { model: p.model, effort: p.effort })
        }
      }
      if (event.type === 'event_msg' && p.type === 'task_complete') {
        result.done.add(p.turn_id)
      }
      if (event.type === 'token_usage_record') {
        addTurn(p.turn_id, event.timestamp)
        result.records.push({ ...p, context: result.contexts.get(p.turn_id) })
      }
      if (event.type !== 'response_item') {
        continue
      }
      if (p.type === 'function_call' && ['spawn_agent', 'followup_task'].includes(p.name)) {
        calls.set(p.call_id, { name: p.name, turn: currentTurn })
        if (p.name === 'followup_task') {
          try {
            const target = JSON.parse(p.arguments).target
            if (typeof target === 'string') {
              result.expected.push({ turn: currentTurn, target })
            }
          } catch {
            /* 실패한 tool call은 새 descendant의 존재 증거가 아니다. */
          }
        }
      }
      if (p.type === 'function_call_output' && calls.get(p.call_id)?.name === 'spawn_agent') {
        try {
          const output = typeof p.output === 'string' ? JSON.parse(p.output) : p.output
          if (typeof output?.task_name === 'string') {
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
  return (
    value &&
    fields.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
    value.cached_input_tokens <= value.input_tokens &&
    value.reasoning_output_tokens <= value.output_tokens &&
    value.total_tokens === value.input_tokens + value.output_tokens
  )
}

export async function collectUsage(
  directory,
  { thread, fromTurn, throughTurn, excludeTurns = [], until = new Date().toISOString() }
) {
  if (!Number.isFinite(Date.parse(until))) {
    throw new Error('유효한 집계 종료 시각이 필요합니다.')
  }
  const catalog = await catalogSessions(directory)
  const root = catalog.get(thread)
  if (!root || root.parent) {
    throw new Error('Root task log를 확인할 수 없습니다.')
  }
  const rootLog = await readSession(root.file, until)
  const first = rootLog.turns.findIndex((turn) => turn.id === fromTurn)
  const last = throughTurn
    ? rootLog.turns.findIndex((turn) => turn.id === throughTurn)
    : rootLog.turns.length - 1
  if (
    first < 0 ||
    last < first ||
    excludeTurns.some((id) => !rootLog.turns.some((turn) => turn.id === id))
  ) {
    throw new Error('명시한 시작/종료/제외 turn 범위를 확인할 수 없습니다.')
  }
  const selected = new Set(
    rootLog.turns
      .slice(first, last + 1)
      .map((turn) => turn.id)
      .filter((id) => !excludeTurns.includes(id))
  )
  if (!selected.size) {
    throw new Error('집계 대상 turn이 없습니다.')
  }
  const family = [root]
  const visited = new Set([thread])
  for (let index = 0; index < family.length; index++) {
    for (const meta of catalog.values()) {
      if (meta.parent === family[index].id && !visited.has(meta.id)) {
        family.push(meta)
        visited.add(meta.id)
      }
    }
  }
  const warnings = new Set()
  const agents = []
  let childIndex = 0
  for (const meta of family) {
    const log = meta === root ? rootLog : await readSession(meta.file, until)
    const inScope = (p) => selected.has(meta === root ? p.turn_id : p.root_turn_id)
    const selectedTurns = new Set(log.records.filter(inScope).map((p) => p.turn_id))
    if (meta === root) {
      for (const id of selected) {
        selectedTurns.add(id)
      }
    }
    const isExpected = meta === root || log.records.some(inScope)
    if (!isExpected) {
      continue
    }
    if (log.truncated) {
      warnings.add('truncated_log')
    }
    if (meta.duplicate) {
      warnings.add('duplicate_conflict')
    }
    const role = meta === root ? 'main' : 'subagent'
    const task = meta.agentPath?.split('/').at(-1)
    const safeTask = /^[a-zA-Z0-9_-]{1,40}$/.test(task ?? '') ? task : 'unknown'
    const agent = meta === root ? 'main' : `subagent_${++childIndex}_${safeTask}`
    if (meta !== root && safeTask === 'unknown') {
      warnings.add('unsafe_metadata')
    }
    for (const expected of log.expected.filter((entry) => selectedTurns.has(entry.turn))) {
      const path = expected.target.startsWith('/')
        ? expected.target
        : `${meta.agentPath}/${expected.target}`
      const child =
        family.find((entry) => entry.id === expected.target) ??
        family.find((entry) => entry.agentPath === path)
      if (!child) {
        warnings.add('descendant_missing')
      } else {
        const childLog = await readSession(child.file, until)
        if (!childLog.records.some((p) => selected.has(p.root_turn_id))) {
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
      if (
        record.thread_id !== meta.id ||
        !record.turn_id ||
        !record.response_id ||
        !validUsage(record.usage)
      ) {
        if (relevant) {
          warnings.add('invalid_usage')
        }
        continue
      }
      const key = JSON.stringify([record.thread_id, record.turn_id, record.response_id])
      if (seen.has(key)) {
        if (fields.some((field) => seen.get(key)[field] !== record.usage[field]) && relevant) {
          warnings.add('duplicate_conflict')
        }
        continue
      }
      seen.set(key, record.usage)
      for (const field of fields) {
        sums[field] += record.usage[field]
      }
      if (record.thread_token_usage) {
        cumulative = record.thread_token_usage
      }
      if (!relevant) {
        continue
      }
      observedTurns.add(record.turn_id)
      const context = record.context ?? log.contexts.get(record.turn_id)
      const model = identifier.test(context?.model ?? '') ? context.model : 'unknown'
      const effort = efforts.has(context?.effort) ? context.effort : 'unknown'
      if (model === 'unknown' || effort === 'unknown') {
        warnings.add('context_missing')
      }
      const group = JSON.stringify([model, effort])
      if (!rows.has(group)) {
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
    if (selectedTurns.size && [...selectedTurns].some((turn) => !observedTurns.has(turn))) {
      warnings.add('usage_missing')
    }
    if (meta !== root && [...selectedTurns].some((turn) => !log.done.has(turn))) {
      warnings.add('scope_incomplete')
    }
    if (cumulative && fields.some((field) => cumulative[field] !== sums[field])) {
      warnings.add('counter_mismatch')
    }
    for (const row of rows.values()) {
      if (names.every((name) => Number.isSafeInteger(row[name]))) {
        agents.push(row)
      } else {
        warnings.add('invalid_usage')
      }
    }
  }
  return {
    period: {
      startedAt: rootLog.turns[first].timestamp,
      capturedAt: new Date(until).toISOString()
    },
    complete: warnings.size === 0,
    warnings: [...warnings].sort(),
    agents
  }
}
