import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { collectUsage, catalogSessions, readSession } from '../collect.mjs'

const before = '2026-01-01T00:00:00.000Z'
const start = '2026-01-01T01:00:00.000Z'
const end = '2026-01-01T02:00:00.000Z'
const later = '2026-01-01T03:00:00.000Z'
const record = (type, payload, timestamp = start) => ({ type, payload, timestamp })
const context = (turn, timestamp = start, model = 'gpt-test', effort = 'high') =>
  record('turn_context', { turn_id: turn, model, effort }, timestamp)
const usage = ({ thread, turn, response, rootTurn = turn, timestamp = start }) =>
  record(
    'token_usage_record',
    {
      thread_id: thread,
      turn_id: turn,
      root_turn_id: rootTurn,
      response_id: response,
      usage: {
        input_tokens: 100,
        cached_input_tokens: 80,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        total_tokens: 120
      }
    },
    timestamp
  )
const done = (turn) => record('event_msg', { type: 'task_complete', turn_id: turn })

async function fixture(t, sessions) {
  const directory = await mkdtemp(join(tmpdir(), 'ldb-usage-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'nested'))
  for (const [id, parent, events, agentPath = `/root/${id}`] of sessions) {
    const isSubagentSource = Boolean(parent)
    const meta = record('session_meta', {
      id,
      parent_thread_id: parent,
      source: isSubagentSource
        ? {
            subagent: {
              thread_spawn: {
                parent_thread_id: parent,
                agent_path: agentPath
              }
            }
          }
        : 'vscode'
    })
    const sessionLogPath = join(directory, 'nested', `${id}.jsonl`)
    const sessionLogBody = [meta, ...events].map((event) => JSON.stringify(event)).join('\n') + '\n'
    await writeFile(sessionLogPath, sessionLogBody)
  }
  return directory
}

test('작업 turn 범위와 recursive descendant를 집계하고 이전/이후 작업을 제외한다', async (t) => {
  const current = usage({ thread: 'root', turn: 'work', response: 'r1' })
  const directory = await fixture(t, [
    [
      'root',
      null,
      [
        context('old', before),
        usage({ thread: 'root', turn: 'old', response: 'old', rootTurn: 'old', timestamp: before }),
        context('work'),
        current,
        current,
        record('event_msg', {
          type: 'token_count',
          info: { total_token_usage: { total_tokens: 99999 } }
        }),
        context('next', later),
        usage({
          thread: 'root',
          turn: 'next',
          response: 'next',
          rootTurn: 'next',
          timestamp: later
        })
      ]
    ],
    [
      'child',
      'root',
      [
        context('c1'),
        usage({ thread: 'child', turn: 'c1', response: 'c1', rootTurn: 'work' }),
        done('c1'),
        context('reuse', later),
        usage({
          thread: 'child',
          turn: 'reuse',
          response: 'c2',
          rootTurn: 'next',
          timestamp: later
        }),
        done('reuse')
      ]
    ],
    [
      'grandchild',
      'child',
      [
        context('g1'),
        usage({ thread: 'grandchild', turn: 'g1', response: 'g1', rootTurn: 'work' }),
        done('g1')
      ]
    ],
    [
      'unrelated',
      null,
      [context('u'), usage({ thread: 'unrelated', turn: 'u', response: 'u', rootTurn: 'work' })]
    ]
  ])
  const result = await collectUsage(directory, { thread: 'root', fromTurn: 'work', until: end })
  assert.equal(result.complete, true)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.agents.length, 3)
  assert.equal(
    result.agents.reduce((sum, row) => sum + row.totalTokens, 0),
    360
  )
  assert.equal(
    result.agents.reduce((sum, row) => sum + row.cachedInputTokens, 0),
    240
  )
  assert.equal(result.period.startedAt, start)
  assert.equal(result.period.capturedAt, end)
  const hasInternalRootTurn = JSON.stringify(result).includes('root_turn_id')
  assert.ok(!hasInternalRootTurn)
})

test('같은 agent의 turn별 모델 변경과 명시적으로 제외한 보고 turn을 보존한다', async (t) => {
  const directory = await fixture(t, [
    [
      'root',
      null,
      [
        context('a'),
        usage({ thread: 'root', turn: 'a', response: 'a' }),
        context('report'),
        usage({ thread: 'root', turn: 'report', response: 'report' }),
        context('b', start, 'gpt-other', 'low'),
        usage({ thread: 'root', turn: 'b', response: 'b' })
      ]
    ]
  ])
  const result = await collectUsage(directory, {
    thread: 'root',
    fromTurn: 'a',
    throughTurn: 'b',
    excludeTurns: ['report'],
    until: end
  })
  assert.equal(result.complete, true)
  assert.deepEqual(
    result.agents.map((row) => [row.agent, row.model, row.effort]),
    [
      ['main', 'gpt-test', 'high'],
      ['main', 'gpt-other', 'low']
    ]
  )
  assert.equal(result.agents[0].totalTokens, 120)
})

test('명시된 시작/끝 turn이 없거나 순서가 뒤집히면 범위를 추측하지 않는다', async (t) => {
  const directory = await fixture(t, [
    [
      'root',
      null,
      [context('a'), usage({ thread: 'root', turn: 'a', response: 'a' }), context('b')]
    ]
  ])
  for (const scope of [
    { fromTurn: 'missing' },
    { fromTurn: 'a', throughTurn: 'missing' },
    { fromTurn: 'b', throughTurn: 'a' }
  ]) {
    await assert.rejects(collectUsage(directory, { thread: 'root', until: end, ...scope }))
  }
})

test('다른 작업에서 생성한 subagent를 재사용해도 현재 root turn 비용만 포함한다', async (t) => {
  const directory = await fixture(t, [
    ['root', null, [context('work'), usage({ thread: 'root', turn: 'work', response: 'r' })]],
    [
      'child',
      'root',
      [
        context('old', before),
        usage({ thread: 'child', turn: 'old', response: 'c0', rootTurn: 'old', timestamp: before }),
        done('old'),
        context('now'),
        usage({ thread: 'child', turn: 'now', response: 'c1', rootTurn: 'work' }),
        done('now')
      ]
    ]
  ])
  const result = await collectUsage(directory, { thread: 'root', fromTurn: 'work', until: end })
  assert.equal(result.agents.length, 2)
  assert.equal(result.agents[1].totalTokens, 120)
})

for (const target of ['child-id', '/root/worker', 'worker']) {
  test(`followup target ${target}은 ID를 우선하고 경로로 재사용한 child도 확인한다`, async (t) => {
    const directory = await fixture(t, [
      [
        'root',
        null,
        [
          context('work'),
          record('response_item', {
            type: 'function_call',
            name: 'followup_task',
            call_id: 'reuse',
            arguments: JSON.stringify({ target })
          }),
          usage({ thread: 'root', turn: 'work', response: 'r' })
        ]
      ],
      [
        'child-id',
        'root',
        [
          context('old', before),
          usage({
            thread: 'child-id',
            turn: 'old',
            response: 'c0',
            rootTurn: 'old',
            timestamp: before
          }),
          done('old'),
          context('now'),
          usage({ thread: 'child-id', turn: 'now', response: 'c1', rootTurn: 'work' }),
          done('now')
        ],
        '/root/worker'
      ],
      [
        'a-decoy',
        'root',
        [
          context('old', before),
          usage({
            thread: 'a-decoy',
            turn: 'old',
            response: 'd0',
            rootTurn: 'old',
            timestamp: before
          }),
          done('old')
        ],
        '/root/child-id'
      ]
    ])
    const result = await collectUsage(directory, { thread: 'root', fromTurn: 'work', until: end })
    assert.equal(result.complete, true)
    assert.deepEqual(result.warnings, [])
    assert.deepEqual(
      result.agents.map(({ agent, totalTokens }) => [agent, totalTokens]),
      [
        ['main', 120],
        ['subagent_1_worker', 120]
      ]
    )
  })
}

test('followup target ID가 다른 root의 agent이면 현재 descendant로 인정하지 않는다', async (t) => {
  const directory = await fixture(t, [
    [
      'root',
      null,
      [
        context('work'),
        record('response_item', {
          type: 'function_call',
          name: 'followup_task',
          call_id: 'reuse',
          arguments: JSON.stringify({ target: 'foreign-id' })
        }),
        usage({ thread: 'root', turn: 'work', response: 'r' })
      ]
    ],
    ['other-root', null, []],
    [
      'foreign-id',
      'other-root',
      [
        context('c'),
        usage({ thread: 'foreign-id', turn: 'c', response: 'c', rootTurn: 'work' }),
        done('c')
      ]
    ]
  ])
  const result = await collectUsage(directory, { thread: 'root', fromTurn: 'work', until: end })
  assert.equal(result.complete, false)
  assert.deepEqual(result.warnings, ['descendant_missing'])
  assert.equal(result.agents.length, 1)
  assert.equal(result.agents[0].role, 'main')
})

test('누락된 model과 충돌 duplicate, 잘못된 counter는 불완전 집계로 표시한다', async (t) => {
  const first = usage({ thread: 'root', turn: 'work', response: 'r' })
  const conflict = structuredClone(first)
  conflict.payload.usage.input_tokens = 200
  conflict.payload.usage.total_tokens = 220
  const invalid = usage({ thread: 'root', turn: 'work', response: 'invalid' })
  invalid.payload.usage.cached_input_tokens = 101
  const directory = await fixture(t, [
    [
      'root',
      null,
      [record('event_msg', { type: 'task_started', turn_id: 'work' }), first, conflict, invalid]
    ]
  ])
  const result = await collectUsage(directory, { thread: 'root', fromTurn: 'work', until: end })
  assert.equal(result.complete, false)
  for (const code of ['context_missing', 'duplicate_conflict', 'invalid_usage']) {
    const hasExpectedWarning = result.warnings.includes(code)
    assert.ok(hasExpectedWarning)
  }
  assert.equal(result.agents[0].model, 'unknown')
  assert.equal(result.agents[0].totalTokens, 120)
})

test('누적 counter와 delta 합계 불일치 및 잘린 JSONL을 감지한다', async (t) => {
  const first = usage({ thread: 'root', turn: 'work', response: 'r' })
  first.payload.thread_token_usage = { ...first.payload.usage, total_tokens: 240 }
  const directory = await fixture(t, [['root', null, [context('work'), first]]])
  await appendFile(join(directory, 'nested/root.jsonl'), '{"type":')
  const result = await collectUsage(directory, { thread: 'root', fromTurn: 'work', until: end })
  assert.equal(result.complete, false)
  const hasTruncatedLogWarning = result.warnings.includes('truncated_log')
  assert.ok(hasTruncatedLogWarning)
  const hasCounterMismatchWarning = result.warnings.includes('counter_mismatch')
  assert.ok(hasCounterMismatchWarning)
})

test('실제로 spawn된 descendant 로그가 없으면 0명으로 보고하지 않는다', async (t) => {
  const directory = await fixture(t, [
    [
      'root',
      null,
      [
        context('work'),
        record('response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'spawn' }),
        record('response_item', {
          type: 'function_call_output',
          call_id: 'spawn',
          output: JSON.stringify({ task_name: '/root/missing' })
        }),
        usage({ thread: 'root', turn: 'work', response: 'r' })
      ]
    ]
  ])
  const result = await collectUsage(directory, { thread: 'root', fromTurn: 'work', until: end })
  assert.equal(result.complete, false)
  const hasDescendantMissingWarning = result.warnings.includes('descendant_missing')
  assert.ok(hasDescendantMissingWarning)
})

test('아직 끝나지 않은 child turn과 usage 없는 root를 불완전으로 표시한다', async (t) => {
  const directory = await fixture(t, [
    ['root', null, [context('work')]],
    [
      'child',
      'root',
      [context('c'), usage({ thread: 'child', turn: 'c', response: 'c', rootTurn: 'work' })]
    ]
  ])
  const result = await collectUsage(directory, { thread: 'root', fromTurn: 'work', until: end })
  assert.equal(result.complete, false)
  const hasUsageMissingWarning = result.warnings.includes('usage_missing')
  assert.ok(hasUsageMissingWarning)
  const hasIncompleteScopeWarning = result.warnings.includes('scope_incomplete')
  assert.ok(hasIncompleteScopeWarning)
  const hasMainAgent = result.agents.some((row) => row.role === 'main')
  assert.equal(hasMainAgent, false)
})

test('공개 결과에 raw prompt, 개인 경로, 내부 ID를 복사하지 않는다', async (t) => {
  const directory = await fixture(t, [
    [
      'root',
      null,
      [
        context('work'),
        record('response_item', {
          type: 'message',
          content: 'PRIVATE_PROMPT /private/user secret-value'
        }),
        usage({ thread: 'root', turn: 'work', response: 'private-response-id' })
      ]
    ]
  ])
  const result = await collectUsage(directory, { thread: 'root', fromTurn: 'work', until: end })
  const output = JSON.stringify(result)
  for (const text of [
    'PRIVATE_PROMPT',
    '/private/user',
    'secret-value',
    'private-response-id',
    'thread_id'
  ]) {
    const hasPrivateText = output.includes(text)
    assert.ok(!hasPrivateText)
  }
  const catalog = await catalogSessions(directory)
  assert.equal(catalog.get('root').parent, null)
  assert.equal((await readSession(catalog.get('root').file, end)).turns[0].id, 'work')
})
