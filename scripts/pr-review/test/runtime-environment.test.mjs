import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const runScript = join(repositoryRoot, 'scripts/pr-review/src/run.mjs')
const triggerScript = join(repositoryRoot, 'scripts/pr-review/src/trigger.mjs')

function baseEnvironment(overrides = {}) {
  const environment = { ...process.env }
  for (const name of [
    'GITHUB_EVENT_PATH',
    'GITHUB_STEP_SUMMARY',
    'GITHUB_TOKEN',
    'REVIEW_TRIGGER_TOKEN',
    'REVIEW_TRIGGER_ACTOR'
  ]) {
    delete environment[name]
  }
  return { ...environment, ...overrides }
}

function execute(scriptPath, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

test('rejects missing and empty required environment values in both entry points', async () => {
  for (const scriptPath of [runScript, triggerScript]) {
    for (const value of [undefined, '']) {
      const environment = baseEnvironment()
      if (value !== undefined) {
        environment.GITHUB_EVENT_PATH = value
      }

      const result = await execute(scriptPath, environment)

      assert.equal(result.code, 1)
      assert.match(result.stderr, /Missing required environment variable: GITHUB_EVENT_PATH/)
    }
  }
})

test('does not append a summary when the summary path is missing or empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ldb-pr-review-runtime-'))
  try {
    const eventPath = join(directory, 'event.json')
    await writeFile(eventPath, JSON.stringify({ workflow_run: { conclusion: 'failure' } }), 'utf8')

    for (const summaryPath of [undefined, '']) {
      const environment = baseEnvironment({ GITHUB_EVENT_PATH: eventPath })
      if (summaryPath !== undefined) {
        environment.GITHUB_STEP_SUMMARY = summaryPath
      }

      const result = await execute(runScript, environment)

      assert.equal(result.code, 0)
      assert.match(result.stdout, /AI review policy skipped: source_workflow_failed/)
      assert.equal(existsSync(join(directory, 'summary.md')), false)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('appends the policy skip message to a configured summary path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ldb-pr-review-runtime-'))
  try {
    const eventPath = join(directory, 'event.json')
    const summaryPath = join(directory, 'summary.md')
    await writeFile(eventPath, JSON.stringify({ workflow_run: { conclusion: 'failure' } }), 'utf8')

    const result = await execute(
      runScript,
      baseEnvironment({
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_STEP_SUMMARY: summaryPath
      })
    )

    assert.equal(result.code, 0)
    assert.equal(
      await readFile(summaryPath, 'utf8'),
      'AI review policy skipped: source_workflow_failed\n'
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
