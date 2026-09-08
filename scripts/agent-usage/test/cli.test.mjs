import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runUsage } from '../../agent-usage.mjs'

const time = '2026-01-01T00:00:00.000Z'
const nextTime = '2026-01-02T00:00:00.000Z'
const end = '2026-01-03T00:00:00.000Z'
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ldb-usage-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', directory])
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'fixture'
    ],
    { cwd: directory }
  )
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8'
  }).trim()
  const sessions = join(directory, 'codex/sessions')
  await mkdir(sessions, { recursive: true })
  const event = (type, payload, timestamp = time) => ({ type, payload, timestamp })
  const events = [event('session_meta', { id: 'root', source: 'vscode' })]
  for (const [turn, timestamp] of [
    ['first', time],
    ['second', nextTime]
  ]) {
    events.push(
      event('turn_context', { turn_id: turn, model: 'gpt-test', effort: 'low' }, timestamp)
    )
    events.push(
      event(
        'token_usage_record',
        {
          thread_id: 'root',
          turn_id: turn,
          root_turn_id: turn,
          response_id: turn,
          usage: {
            input_tokens: 10,
            cached_input_tokens: 8,
            output_tokens: 2,
            reasoning_output_tokens: 1,
            total_tokens: 12
          }
        },
        timestamp
      )
    )
  }
  await writeFile(
    join(sessions, 'root.jsonl'),
    events.map((row) => JSON.stringify(row)).join('\n') + '\n'
  )
  const output = []
  const options = {
    cwd: directory,
    env: { CODEX_HOME: join(directory, 'codex'), CODEX_THREAD_ID: 'root' },
    write: (text) => output.push(text),
    call: (args) => {
      if (args[0] === 'repo') {
        return { nameWithOwner: 'owner/repo' }
      }
      if (args[0] === 'pr') {
        return {
          number: 3,
          url: 'https://github.com/owner/repo/pull/3',
          headRefOid: head,
          state: 'OPEN',
          mergedAt: null,
          isCrossRepository: false,
          author: { login: 'owner' },
          closingIssuesReferences: [
            { number: 1, repository: { name: 'repo', owner: { login: 'owner' } } }
          ]
        }
      }
      throw new Error('Unexpected network write')
    }
  }
  return { directory, options, output }
}

test('begin은 local manifest를 저장하고 시작 turn의 조용한 덮어쓰기를 거부한다', async (t) => {
  const { directory, options } = await setup(t)
  await runUsage(['begin', '--issue', '1', '--from-turn', 'first'], options)
  await runUsage(['begin', '--issue', '1', '--from-turn', 'first'], options)
  const manifest = JSON.parse(
    await readFile(join(directory, '.git/agent-usage/issue-1.json'), 'utf8')
  )
  assert.equal(manifest.thread, 'root')
  assert.equal(manifest.fromTurn, 'first')
  await assert.rejects(runUsage(['begin', '--issue', '1', '--from-turn', 'second'], options))
  assert.equal(execFileSync('git', ['ls-files'], { cwd: directory, encoding: 'utf8' }), '')
})

test('canonical repository와 --repo 대소문자가 달라도 begin과 snapshot이 같은 작업을 사용한다', async (t) => {
  const { options, output } = await setup(t)
  const call = options.call
  options.call = (args) => (args[0] === 'repo' ? { nameWithOwner: 'Owner/Repo' } : call(args))
  const begin = ['begin', '--issue', '1', '--from-turn', 'first']
  await runUsage(begin, options)
  await runUsage([...begin, '--repo', 'OWNER/repo'], options)
  await runUsage(
    [
      'snapshot',
      '--issue',
      '1',
      '--pr',
      '3',
      '--repo',
      'owner/REPO',
      '--through-turn',
      'first',
      '--until',
      end,
      '--json'
    ],
    options
  )
  const snapshot = JSON.parse(output.at(-1))
  assert.equal(snapshot.repository, 'owner/repo')
  assert.equal(snapshot.agents[0].totalTokens, 12)
  await assert.rejects(runUsage([...begin, '--repo', 'different/repo'], options), /덮어/)
  await assert.rejects(
    runUsage(['snapshot', '--issue', '1', '--pr', '3', '--repo', 'different/repo'], options),
    /기록/
  )
})

test('기존 mixed-case repository manifest도 원래 작업 범위를 유지하며 재사용한다', async (t) => {
  const { directory, options, output } = await setup(t)
  const begin = ['begin', '--issue', '1', '--from-turn', 'first']
  await runUsage(begin, options)
  const file = join(directory, '.git/agent-usage/issue-1.json')
  const legacy = { ...JSON.parse(await readFile(file, 'utf8')), repository: 'Owner/Repo' }
  await writeFile(file, JSON.stringify(legacy))
  await runUsage([...begin, '--repo', 'OWNER/REPO'], options)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), legacy)
  await runUsage(
    [
      'snapshot',
      '--issue',
      '1',
      '--pr',
      '3',
      '--repo',
      'owner/repo',
      '--through-turn',
      'first',
      '--until',
      end,
      '--json'
    ],
    options
  )
  assert.equal(JSON.parse(output.at(-1)).agents[0].totalTokens, 12)
})

test('snapshot은 명시적 종료 범위로 요약하고 --publish 없이는 GitHub에 쓰지 않는다', async (t) => {
  const { directory, options, output } = await setup(t)
  await runUsage(['begin', '--issue', '1', '--from-turn', 'first'], options)
  await runUsage(
    ['snapshot', '--issue', '1', '--pr', '3', '--through-turn', 'first', '--until', end, '--json'],
    options
  )
  const snapshot = JSON.parse(output.at(-1))
  assert.equal(snapshot.agents[0].totalTokens, 12)
  assert.equal(snapshot.issue, 1)
  assert.equal(snapshot.pullRequest, 3)
  assert.ok(!JSON.stringify(snapshot).includes('fromTurn'))
  const manifest = JSON.parse(
    await readFile(join(directory, '.git/agent-usage/issue-1.json'), 'utf8')
  )
  assert.equal(manifest.throughTurn, 'first')
  assert.equal(manifest.until, end)
})

test('다른 Issue가 시작된 turn까지 기존 Issue 범위를 자동 확장하지 않는다', async (t) => {
  const { options } = await setup(t)
  await runUsage(['begin', '--issue', '1', '--from-turn', 'first'], options)
  await runUsage(['begin', '--issue', '2', '--from-turn', 'second'], options)
  await assert.rejects(
    runUsage(['snapshot', '--issue', '1', '--pr', '3', '--until', end], options),
    /겹/
  )
})

test('snapshot 재실행은 저장한 종료 범위를 유지하며 merged PR backfill도 재생성한다', async (t) => {
  const { options, output } = await setup(t)
  await runUsage(['begin', '--issue', '1', '--from-turn', 'first'], options)
  const args = ['snapshot', '--issue', '1', '--pr', '3', '--json']
  await runUsage([...args, '--through-turn', 'first', '--until', end], options)
  const original = JSON.parse(output.at(-1))
  await runUsage(args, options)
  assert.deepEqual(JSON.parse(output.at(-1)), original)
  const call = options.call
  options.call = (arguments_) =>
    arguments_[0] === 'pr'
      ? { ...call(arguments_), state: 'MERGED', mergedAt: end }
      : call(arguments_)
  await runUsage(args, options)
  assert.deepEqual(JSON.parse(output.at(-1)), original)
})

test('추가 작업은 --refresh로 명시한 경우에만 종료 범위를 확장한다', async (t) => {
  const { options, output } = await setup(t)
  await runUsage(['begin', '--issue', '1', '--from-turn', 'first'], options)
  const args = ['snapshot', '--issue', '1', '--pr', '3', '--json']
  await runUsage([...args, '--through-turn', 'first', '--until', end], options)
  await runUsage([...args, '--refresh'], options)
  const refreshed = JSON.parse(output.at(-1))
  assert.equal(refreshed.agents[0].totalTokens, 24)
  assert.ok(Date.parse(refreshed.period.capturedAt) > Date.parse(end))
  await runUsage(args, options)
  assert.deepEqual(JSON.parse(output.at(-1)), refreshed)
})

test('PR의 linked Issue가 다르면 snapshot을 저장하지 않는다', async (t) => {
  const { options } = await setup(t)
  await runUsage(['begin', '--issue', '2', '--from-turn', 'first'], options)
  await assert.rejects(
    runUsage(['snapshot', '--issue', '2', '--pr', '3', '--until', end], options),
    /Issue/
  )
})

test('누락된 manifest 또는 잘못된 command/숫자 입력을 거부한다', async (t) => {
  const { options } = await setup(t)
  for (const args of [
    ['begin', '--issue', '0'],
    ['begin', '--issue', '../1'],
    ['snapshot', '--issue', '1', '--pr', '3'],
    ['surprise']
  ]) {
    await assert.rejects(runUsage(args, options))
  }
})
