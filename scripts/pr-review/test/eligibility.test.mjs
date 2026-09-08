import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateReviewRequest } from '../src/eligibility.mjs'

function createEvent(overrides = {}) {
  const pullRequest = {
    number: 4,
    body: 'Related to #2',
    draft: false,
    labels: [{ name: '@ldb-review' }],
    head: {
      sha: 'head-sha',
      repo: { full_name: 'blahaj94/ldb' }
    },
    base: {
      sha: 'base-sha',
      repo: { full_name: 'blahaj94/ldb' }
    },
    ...overrides.pull_request
  }

  return {
    action: 'labeled',
    label: { name: '@ldb-review' },
    repository: { full_name: 'blahaj94/ldb', owner: { login: 'blahaj94' } },
    pull_request: pullRequest,
    ...overrides,
    pull_request: pullRequest
  }
}

test('accepts the target label on a same-repository non-draft PR', () => {
  assert.deepEqual(evaluateReviewRequest(createEvent()), {
    eligible: true,
    reason: 'eligible'
  })
})

test('accepts a new head SHA while the target label remains', () => {
  const event = createEvent({ action: 'synchronize', label: undefined })

  assert.equal(evaluateReviewRequest(event).eligible, true)
})

test('rejects a labeled event for a different label', () => {
  const event = createEvent({ label: { name: 'documentation' } })

  assert.deepEqual(evaluateReviewRequest(event), {
    eligible: false,
    reason: 'label_event_mismatch'
  })
})

test('rejects PRs without the target label', () => {
  const event = createEvent({
    pull_request: { labels: [{ name: 'documentation' }] }
  })

  assert.equal(evaluateReviewRequest(event).reason, 'label_missing')
})

test('rejects draft PRs', () => {
  const event = createEvent({ pull_request: { draft: true } })

  assert.equal(evaluateReviewRequest(event).reason, 'draft')
})

test('rejects fork PRs', () => {
  const event = createEvent({
    pull_request: {
      head: { sha: 'head-sha', repo: { full_name: 'outside/fork' } }
    }
  })

  assert.equal(evaluateReviewRequest(event).reason, 'fork')
})

test('rejects unsupported pull request actions', () => {
  const event = createEvent({ action: 'opened', label: undefined })

  assert.equal(evaluateReviewRequest(event).reason, 'unsupported_action')
})
