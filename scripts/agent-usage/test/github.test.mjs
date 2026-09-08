import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { publishReport, saveSnapshot } from '../github.mjs'
import { SNAPSHOT_MARKER, snapshotComment } from '../report.mjs'

const REPOSITORY = 'owner/repo'
const HEAD = 'a'.repeat(40)
const originalGitHubActions = process.env.GITHUB_ACTIONS
process.env.GITHUB_ACTIONS = 'false'
after(() => {
  if (originalGitHubActions === undefined) {
    delete process.env.GITHUB_ACTIONS
  } else {
    process.env.GITHUB_ACTIONS = originalGitHubActions
  }
})

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: REPOSITORY,
    issue: 34,
    pullRequest: 35,
    headSha: HEAD,
    period: {
      startedAt: '2026-09-05T00:00:00.000Z',
      capturedAt: '2026-09-05T01:00:00.000Z'
    },
    complete: true,
    warnings: [],
    agents: [
      {
        role: 'main',
        agent: 'root',
        model: 'gpt-5',
        effort: 'high',
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 120
      }
    ],
    ...overrides
  }
}

function createAgents(count) {
  return Array.from({ length: count }, (_, index) => ({
    role: index === 0 ? 'main' : 'subagent',
    agent: `agent-${index}-${'x'.repeat(50)}`,
    model: 'm'.repeat(80),
    effort: 'ultra',
    inputTokens: 900_719_925,
    cachedInputTokens: 123_456_789,
    outputTokens: 123_456_789,
    reasoningOutputTokens: 12_345_678,
    totalTokens: 1_024_176_714
  }))
}

function pullRequest(overrides = {}) {
  return {
    number: 35,
    url: 'https://github.com/owner/repo/pull/35',
    state: 'MERGED',
    mergedAt: '2026-09-05T02:00:00Z',
    headRefOid: HEAD,
    isCrossRepository: false,
    author: { login: 'author' },
    closingIssuesReferences: [
      {
        number: 34,
        repository: { name: 'repo', owner: { login: 'owner' } },
        url: 'https://github.com/owner/repo/issues/34'
      }
    ],
    ...overrides
  }
}

function apiMock({ pr = pullRequest(), prComments = [], issueComments = [] } = {}) {
  const calls = []
  const call = (args, body) => {
    calls.push({ args, body })
    if (args[0] === 'pr') {
      return pr
    }
    if (args.join(' ') === 'api user') {
      return { login: 'author' }
    }
    const endpoint = args.find((part) => part.startsWith('repos/'))
    if (args.includes('--paginate')) {
      return endpoint.endsWith('issues/35/comments') ? [prComments] : [issueComments]
    }
    if (args.includes('PATCH')) {
      return { html_url: 'https://github.com/comment/updated' }
    }
    if (args.includes('POST')) {
      return { html_url: 'https://github.com/comment/created' }
    }
    throw new Error(`Unexpected mock call ${args.join(' ')}`)
  }
  return { call, calls }
}

test('saveSnapshot requires current same-repository PR head and linked manifest issue', () => {
  for (const pr of [
    pullRequest({ headRefOid: 'b'.repeat(40) }),
    pullRequest({ isCrossRepository: true }),
    pullRequest({ closingIssuesReferences: [] }),
    pullRequest({ mergedAt: '2026-09-05T00:30:00Z' })
  ]) {
    assert.throws(
      () => saveSnapshot(snapshot(), apiMock({ pr }).call),
      /Unable to save usage snapshot/
    )
  }
})

test('saveSnapshot rejects oversized rendered comments before GitHub calls', () => {
  const mock = apiMock()
  assert.throws(
    () => saveSnapshot(snapshot({ agents: createAgents(100) }), mock.call),
    /65536 character limit/
  )
  assert.deepEqual(mock.calls, [])
})

test("saveSnapshot updates only the current actor's marked comment", () => {
  const other = { id: 1, body: `${SNAPSHOT_MARKER}\nother`, user: { login: 'someone' } }
  const own = { id: 2, body: `${SNAPSHOT_MARKER}\nown`, user: { login: 'author' } }
  const mock = apiMock({ prComments: [other, own] })
  const result = saveSnapshot(snapshot(), mock.call)
  assert.equal(result.status, 'updated')
  const patch = mock.calls.find(({ args }) => args.includes('PATCH'))
  assert.match(patch.args.join(' '), /issues\/comments\/2/)
  assert.equal(patch.body.body, snapshotComment(snapshot()))
})

test('saveSnapshot creates a comment instead of overwriting another author', () => {
  const mock = apiMock({
    prComments: [{ id: 1, body: SNAPSHOT_MARKER, user: { login: 'someone' } }]
  })
  const result = saveSnapshot(snapshot(), mock.call)
  assert.equal(result.status, 'created')
  const hasPostCall = mock.calls.some(({ args }) => args.includes('POST'))
  const hasPatchCall = mock.calls.some(({ args }) => args.includes('PATCH'))
  assert.ok(hasPostCall)
  assert.ok(!hasPatchCall)
})

test('saveSnapshot recognizes the default workflow token actor', () => {
  process.env.GITHUB_ACTIONS = 'true'
  try {
    const mock = apiMock({
      prComments: [{ id: 3, body: SNAPSHOT_MARKER, user: { login: 'github-actions[bot]' } }]
    })
    assert.equal(saveSnapshot(snapshot(), mock.call).status, 'updated')
    const hasPatchCall = mock.calls.some(({ args }) => args.includes('PATCH'))
    const hasUserLookup = mock.calls.some(({ args }) => args.join(' ') === 'api user')
    assert.ok(hasPatchCall)
    assert.ok(!hasUserLookup)
  } finally {
    process.env.GITHUB_ACTIONS = 'false'
  }
})

test('publishReport skips unmerged and fork PRs without writing', () => {
  for (const pr of [
    pullRequest({ state: 'CLOSED', mergedAt: null }),
    pullRequest({ isCrossRepository: true })
  ]) {
    const mock = apiMock({ pr })
    assert.deepEqual(publishReport(REPOSITORY, 35, mock.call), { status: 'skipped', issues: [] })
    const hasWriteCall = mock.calls.some(
      ({ args }) => args.includes('POST') || args.includes('PATCH')
    )
    assert.ok(!hasWriteCall)
  }
})

test('publishReport trusts latest snapshot only from PR author or repository owner', () => {
  const valid = snapshotComment(snapshot())
  const mock = apiMock({
    prComments: [
      { id: 1, body: valid, user: { login: 'author' }, created_at: '2026-09-05T01:10:00Z' },
      {
        id: 2,
        body: valid.replace(HEAD, 'b'.repeat(40)),
        user: { login: 'attacker' },
        created_at: '2026-09-05T01:20:00Z'
      }
    ]
  })
  const result = publishReport(REPOSITORY, 35, mock.call)
  assert.equal(result.status, 'published')
  assert.deepEqual(result.issues, ['https://github.com/owner/repo/issues/34'])
  const post = mock.calls.find(({ args }) => args.includes('POST'))
  assert.match(post.body.body, /PR #35/)
  assert.doesNotMatch(post.body.body, /attacker/)
})

test('publishReport uses the most recently updated trusted snapshot', () => {
  const current = snapshotComment(snapshot())
  const stale = snapshotComment(snapshot({ headSha: 'b'.repeat(40) }))
  const mock = apiMock({
    prComments: [
      {
        id: 1,
        body: current,
        user: { login: 'author' },
        created_at: '2026-09-05T00:30:00Z',
        updated_at: '2026-09-05T01:30:00Z'
      },
      {
        id: 2,
        body: stale,
        user: { login: 'owner' },
        created_at: '2026-09-05T01:00:00Z',
        updated_at: '2026-09-05T01:00:00Z'
      }
    ]
  })
  assert.equal(publishReport(REPOSITORY, 35, mock.call).status, 'published')
})

test('publishReport rejects a snapshot whose manifest issue is no longer linked', () => {
  const mock = apiMock({
    prComments: [
      {
        body: snapshotComment(snapshot({ issue: 99 })),
        user: { login: 'author' },
        created_at: '2026-09-05T01:00:00Z'
      }
    ]
  })
  const result = publishReport(REPOSITORY, 35, mock.call)
  assert.equal(result.status, 'unavailable')
  const post = mock.calls.find(({ args }) => args.includes('POST'))
  assert.match(post.body.body, /연결된 Issue/)
  assert.match(post.body.body, /추정하지 않았습니다/)
})

test('publishReport posts unavailable without zeros for missing or stale snapshot', () => {
  for (const prComments of [
    [],
    [
      {
        body: snapshotComment(snapshot({ headSha: 'b'.repeat(40) })),
        user: { login: 'author' },
        created_at: '2026-09-05T01:00:00Z'
      }
    ]
  ]) {
    const mock = apiMock({ prComments })
    const result = publishReport(REPOSITORY, 35, mock.call)
    assert.equal(result.status, 'unavailable')
    const post = mock.calls.find(({ args }) => args.includes('POST'))
    assert.match(post.body.body, /보고할 수 없습니다/)
    assert.match(post.body.body, /추정하지 않았습니다/)
    assert.doesNotMatch(post.body.body, /\|\s*0\s*\|/)
  }
})

test('publishReport posts observed partial counts but remains unavailable', () => {
  const partial = snapshot({ complete: false, warnings: ['scope_incomplete'] })
  const mock = apiMock({
    prComments: [
      {
        body: snapshotComment(partial),
        user: { login: 'owner' },
        created_at: '2026-09-05T01:00:00Z'
      }
    ]
  })
  const result = publishReport(REPOSITORY, 35, mock.call)
  assert.equal(result.status, 'unavailable')
  const post = mock.calls.find(({ args }) => args.includes('POST'))
  assert.match(post.body.body, /부분 관측/)
  assert.match(post.body.body, /120/)
})

test('publishReport updates only its own per-PR marker on repeat', () => {
  const existing = {
    id: 9,
    body: '<!-- ldb-agent-usage-report:owner/repo#35 -->\nold',
    user: { login: 'author' }
  }
  const mock = apiMock({
    prComments: [
      {
        body: snapshotComment(snapshot()),
        user: { login: 'author' },
        created_at: '2026-09-05T01:00:00Z'
      }
    ],
    issueComments: [{ id: 8, body: existing.body, user: { login: 'someone' } }, existing]
  })
  assert.equal(publishReport(REPOSITORY, 35, mock.call).status, 'published')
  const patch = mock.calls.find(({ args }) => args.includes('PATCH'))
  assert.match(patch.args.join(' '), /issues\/comments\/9/)
  const hasPostCall = mock.calls.some(({ args }) => args.includes('POST'))
  assert.ok(!hasPostCall)
})

test('publishReport targets every linked same-repository issue only', () => {
  const pr = pullRequest({
    closingIssuesReferences: [
      ...pullRequest().closingIssuesReferences,
      {
        number: 36,
        repository: { name: 'repo', owner: { login: 'owner' } },
        url: 'https://github.com/owner/repo/issues/36'
      },
      {
        number: 7,
        repository: { name: 'other', owner: { login: 'owner' } },
        url: 'https://github.com/owner/other/issues/7'
      }
    ]
  })
  const mock = apiMock({
    pr,
    prComments: [
      {
        body: snapshotComment(snapshot()),
        user: { login: 'author' },
        created_at: '2026-09-05T01:00:00Z'
      }
    ]
  })
  const result = publishReport(REPOSITORY, 35, mock.call)
  assert.deepEqual(result.issues, [
    'https://github.com/owner/repo/issues/34',
    'https://github.com/owner/repo/issues/36'
  ])
  assert.equal(mock.calls.filter(({ args }) => args.includes('POST')).length, 2)
})
