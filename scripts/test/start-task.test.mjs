import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { startTask } from '../start-task.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ldb-start-task-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const repository = join(directory, 'repository')
  const origin = join(directory, 'origin.git')
  const destination = join(directory, 'worktree with spaces')
  mkdirSync(repository)
  const git = (args, cwd = repository) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  git(['init', '--initial-branch=main'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repository, 'README.md'), 'initial\n')
  git(['add', 'README.md'])
  git(['commit', '--no-verify', '-m', 'initial'])
  git(['clone', '--bare', repository, origin])
  git(['remote', 'add', 'origin', origin])
  git(['fetch', 'origin', 'main'])
  const calls = []
  const issue = {
    number: 30,
    title: 'Test task',
    url: 'https://example.invalid/issues/30',
    state: 'OPEN'
  }
  const run = (command, args, options) => {
    calls.push([command, ...args])
    if (command === 'gh') {
      return JSON.stringify(issue)
    }
    return execFileSync(command, args, {
      ...options,
      cwd: repository,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }
  return { repository, origin, destination, git, calls, issue, run }
}

test('creates an isolated Issue branch at freshly fetched main and returns concise context', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.repository, 'README.md'), 'new main\n')
  f.git(['commit', '--no-verify', '-am', 'new main'])
  const latest = f.git(['rev-parse', 'HEAD'])
  f.git(['push', 'origin', 'main'])
  f.git(['reset', '--hard', 'HEAD~1'])
  writeFileSync(join(f.repository, 'local.txt'), 'keep me\n')
  const headBefore = f.git(['rev-parse', 'HEAD'])

  const result = startTask(['30', f.destination], f.run)

  assert.equal(f.git(['rev-parse', 'HEAD'], f.destination), latest)
  assert.equal(f.git(['branch', '--show-current'], f.destination), 'codex/issue-30')
  assert.equal(f.git(['rev-parse', 'HEAD']), headBefore)
  assert.equal(readFileSync(join(f.repository, 'local.txt'), 'utf8'), 'keep me\n')
  assert.match(result, /Test task/)
  assert.match(result, /https:\/\/example\.invalid\/issues\/30/)
  assert.ok(result.includes(f.destination))
  assert.deepEqual(f.calls[0], ['gh', 'issue', 'view', '30', '--json', 'number,title,url,state'])
})

test('rejects invalid arguments without external commands', () => {
  for (const args of [
    [],
    ['30'],
    ['0', 'target'],
    ['-1', 'target'],
    ['1;echo', 'target'],
    ['9007199254740992', 'target'],
    ['30', ' '],
    ['30', 'target', 'extra']
  ]) {
    assert.throws(() => startTask(args, () => assert.fail('must not invoke a command')), /사용법/)
  }
})

test('closed or mismatched Issue and GitHub failure do not fetch or create a worktree', (t) => {
  const f = fixture(t)
  f.issue.state = 'CLOSED'
  assert.throws(() => startTask(['30', f.destination], f.run), /OPEN/)
  f.issue.state = 'OPEN'
  f.issue.number = 31
  assert.throws(() => startTask(['30', f.destination], f.run), /Issue/)
  assert.ok(f.calls.every(([command]) => command === 'gh'))
  assert.throws(
    () =>
      startTask(['30', f.destination], () => {
        throw new Error('GitHub unavailable')
      }),
    /GitHub unavailable/
  )
  assert.equal(existsSync(f.destination), false)
})

test('fetch failure cannot fall back to stale origin/main', (t) => {
  const f = fixture(t)
  f.git(['remote', 'set-url', 'origin', join(f.repository, 'missing-origin.git')])
  assert.throws(() => startTask(['30', f.destination], f.run))
  assert.equal(existsSync(f.destination), false)
  assert.equal(f.git(['branch', '--list', 'codex/issue-30']), '')
})

test('existing destination and branch remain untouched', (t) => {
  const f = fixture(t)
  mkdirSync(f.destination)
  assert.throws(() => startTask(['30', f.destination], f.run), /이미 존재/)
  assert.equal(f.git(['branch', '--list', 'codex/issue-30']), '')
  writeFileSync(join(f.destination, 'keep.txt'), 'keep\n')
  assert.throws(() => startTask(['30', f.destination], f.run), /이미 존재/)
  assert.equal(readFileSync(join(f.destination, 'keep.txt'), 'utf8'), 'keep\n')

  f.git(['branch', 'codex/issue-30'])
  const original = f.git(['rev-parse', 'codex/issue-30'])
  const otherPath = join(f.repository, 'other-worktree')
  assert.throws(() => startTask(['30', otherPath], f.run))
  assert.equal(f.git(['rev-parse', 'codex/issue-30']), original)
  assert.equal(existsSync(otherPath), false)
})

test('CLI reports invalid input with a failing exit status', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../start-task.mjs', import.meta.url))],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /사용법/)
})
