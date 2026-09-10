import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPolicySummary,
  buildProviderTriggerComment,
  findCommentByMarker,
  providerMarker
} from '../src/comments.mjs'

test('builds a provider-specific trigger behind a generic marker', () => {
  const body = buildProviderTriggerComment({
    provider: 'codex',
    headSha: 'abc123'
  })

  assert.match(body, /<!-- ldb-ai-review:codex:abc123 -->/)
  assert.match(body, /@codex review/)
  assert.match(body, /리뷰 제목과 본문은 한국어 존댓말로 작성해 주세요\./)
})

test('finds an existing trigger for the reviewed head SHA', () => {
  const marker = providerMarker('codex', 'abc123')
  const comments = [
    { id: 1, body: 'unrelated' },
    { id: 2, body: `${marker}\n@codex review` }
  ]

  assert.equal(findCommentByMarker(comments, marker)?.id, 2)
})

test('renders one advisory policy summary with stable metadata', () => {
  const summary = buildPolicySummary({
    headSha: 'abc123',
    checks: [
      { name: 'linked_issue', status: 'pass', detail: '#2' },
      {
        name: 'test_evidence',
        status: 'warning',
        detail: 'No Red test commit found'
      }
    ]
  })

  assert.match(summary, /<!-- ldb-ai-review-policy -->/)
  assert.match(summary, /Advisory/)
  assert.match(summary, /abc123/)
  assert.match(summary, /No Red test commit found/)
})
