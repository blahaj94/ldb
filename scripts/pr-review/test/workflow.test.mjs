import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflowUrl = new URL('../../../.github/workflows/ai-pr-review.yml', import.meta.url)
const trustedWorkflowUrl = new URL(
  '../../../.github/workflows/ai-pr-review-trusted.yml',
  import.meta.url
)

test('PR signal workflow is label-gated and has no write authority', async () => {
  const workflow = await readFile(workflowUrl, 'utf8')

  assert.match(workflow, /pull_request:/)
  assert.match(workflow, /labeled/)
  assert.match(workflow, /@ldb-review/)
  assert.match(workflow, /permissions: \{\}/)
  assert.doesNotMatch(workflow, /actions\/checkout/)
  assert.doesNotMatch(workflow, /pull-requests: write/)
  assert.doesNotMatch(workflow, /issues: write/)
  assert.doesNotMatch(workflow, /pull_request_target/)
  assert.doesNotMatch(workflow, /contents: write/)
  assert.doesNotMatch(workflow, /secrets\./)
  assert.doesNotMatch(workflow, /run:.*#\$\{\{/)
})

test('trusted workflow runs default-branch code and isolates the trigger Secret', async () => {
  const workflow = await readFile(trustedWorkflowUrl, 'utf8')

  assert.match(workflow, /workflow_run:/)
  assert.match(workflow, /workflows: \['AI PR Review'\]/)
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/)
  assert.match(workflow, /LDB_REVIEW_TRIGGER_TOKEN/)
  assert.match(workflow, /jobs:\s+policy:/s)
  assert.match(workflow, /\n {2}trigger:/)
  assert.doesNotMatch(workflow, /pull_request_target/)
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/)
})
