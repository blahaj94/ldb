import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync('.github/workflows/agent-usage-report.yml', 'utf8')

test('workflow uses trusted code, narrow permissions, and bounded execution', () => {
  assert.match(workflow, /pull_request:\s*\n\s+types: \[closed\]/)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /merged == true/)
  assert.match(workflow, /head\.repo\.full_name == github\.repository/)
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/)
  assert.match(workflow, /contents: read/)
  assert.match(workflow, /pull-requests: read/)
  assert.match(workflow, /issues: write/)
  assert.match(workflow, /timeout-minutes: [1-9]/)
  assert.match(workflow, /cancel-in-progress: false/)
  assert.match(workflow, /node scripts\/agent-usage\.mjs publish/)
  assert.doesNotMatch(workflow, /npm (install|ci)|pull_request_target|OPENAI|ANTHROPIC/)
})

test('workflow supports a validated explicit PR number for retry', () => {
  assert.match(workflow, /pr_number:/)
  assert.match(workflow, /github\.event\.inputs\.pr_number/)
  assert.match(workflow, /USAGE_PR_NUMBER/)
  assert.match(workflow, /GITHUB_REPOSITORY/)
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/)
})
