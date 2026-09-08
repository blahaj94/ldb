import { execFileSync } from 'node:child_process'

import {
  SNAPSHOT_MARKER,
  parseSnapshotComment,
  renderReport,
  snapshotComment,
  validateSnapshot
} from './report.mjs'

const PR_FIELDS = [
  'number',
  'url',
  'state',
  'mergedAt',
  'headRefOid',
  'isCrossRepository',
  'author',
  'closingIssuesReferences'
].join(',')

export function ghJson(args, body) {
  try {
    const hasBody = body !== undefined
    const output = execFileSync('gh', args, {
      encoding: 'utf8',
      ...(hasBody ? { input: JSON.stringify(body) } : {})
    })
    const hasOutput = output.trim().length > 0
    return hasOutput ? JSON.parse(output) : null
  } catch {
    throw new Error('GitHub CLI request failed')
  }
}

export function getPullRequest(repository, number, call = ghJson) {
  return call(['pr', 'view', String(number), '--repo', repository, '--json', PR_FIELDS])
}

function sameRepository(reference, repository) {
  const [owner, name] = repository.toLowerCase().split('/')
  const hasSameOwner = reference?.repository?.owner?.login?.toLowerCase() === owner
  const isSameRepository = hasSameOwner && reference?.repository?.name?.toLowerCase() === name
  return isSameRepository
}

function linkedIssues(pr, repository) {
  const seen = new Set()
  return (pr.closingIssuesReferences ?? []).filter((reference) => {
    const isSameRepository = sameRepository(reference, repository)
    const isSafeIssueNumber = isSameRepository && Number.isSafeInteger(reference.number)
    const isIssueNumberBelowMinimum = isSafeIssueNumber && reference.number < 1
    const isReferenceInvalid = !isSameRepository || !isSafeIssueNumber || isIssueNumberBelowMinimum
    if (isReferenceInvalid) {
      return false
    }
    const isDuplicateIssue = seen.has(reference.number)
    if (isDuplicateIssue) {
      return false
    }
    seen.add(reference.number)
    return true
  })
}

function currentActor(call) {
  const isGitHubActions = process.env.GITHUB_ACTIONS === 'true'
  if (isGitHubActions) {
    return 'github-actions[bot]'
  }
  const actor = call(['api', 'user'])
  const isActorLoginString = typeof actor?.login === 'string'
  if (!isActorLoginString) {
    throw new Error('Actor unavailable')
  }
  return actor.login
}

function listComments(repository, number, call) {
  const result = call([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repository}/issues/${number}/comments`
  ])
  const isCommentPageArray = Array.isArray(result)
  if (!isCommentPageArray) {
    throw new Error('Comments unavailable')
  }
  return result.flat()
}

function commentAuthor(comment) {
  return comment?.user?.login ?? comment?.author?.login
}

function writeComment(repository, number, body, marker, actor, call) {
  const comments = listComments(repository, number, call)
  const own = comments.find((comment) => {
    const isBodyString = typeof comment.body === 'string'
    const hasMarker = isBodyString && comment.body.includes(marker)
    const isOwnMarkedComment =
      hasMarker && commentAuthor(comment)?.toLowerCase() === actor.toLowerCase()
    return isOwnMarkedComment
  })
  const hasOwnComment = own != null
  if (hasOwnComment) {
    call(
      ['api', '--method', 'PATCH', `repos/${repository}/issues/comments/${own.id}`, '--input', '-'],
      { body }
    )
    return { status: 'updated' }
  }
  call(
    ['api', '--method', 'POST', `repos/${repository}/issues/${number}/comments`, '--input', '-'],
    { body }
  )
  return { status: 'created' }
}

function matchesSnapshot(snapshot, repository, pr) {
  const hasSameRepository = snapshot.repository.toLowerCase() === repository.toLowerCase()
  const hasSamePullRequest = hasSameRepository && snapshot.pullRequest === pr.number
  const hasSameHead =
    hasSamePullRequest && snapshot.headSha.toLowerCase() === pr.headRefOid?.toLowerCase()
  if (!hasSameHead) {
    return false
  }
  const mergedAt = pr.mergedAt
  const isMergeTimeAbsent =
    mergedAt == null ||
    mergedAt === '' ||
    mergedAt === false ||
    mergedAt === 0 ||
    mergedAt === 0n ||
    Number.isNaN(mergedAt)
  const isCapturedBeforeMerge =
    isMergeTimeAbsent || Date.parse(snapshot.period.capturedAt) <= Date.parse(pr.mergedAt)
  return isCapturedBeforeMerge
}

export function saveSnapshot(value, call = ghJson) {
  try {
    const snapshot = validateSnapshot(value)
    const body = snapshotComment(snapshot)
    const pr = getPullRequest(snapshot.repository, snapshot.pullRequest, call)
    const issueIsLinked = linkedIssues(pr, snapshot.repository).some(
      ({ number }) => number === snapshot.issue
    )
    const hasSamePullRequest = pr.number === snapshot.pullRequest
    const isSameRepositoryPullRequest = hasSamePullRequest && pr.isCrossRepository === false
    const isLinkedPullRequest = isSameRepositoryPullRequest && issueIsLinked
    const isEligibleSnapshot =
      isLinkedPullRequest && matchesSnapshot(snapshot, snapshot.repository, pr)
    if (!isEligibleSnapshot) {
      throw new Error('Ineligible snapshot')
    }
    const actor = currentActor(call)
    return writeComment(
      snapshot.repository,
      snapshot.pullRequest,
      body,
      SNAPSHOT_MARKER,
      actor,
      call
    )
  } catch (error) {
    const isCommentTooLong = error?.code === 'COMMENT_TOO_LONG'
    if (isCommentTooLong) {
      throw error
    }
    throw new Error('Unable to save usage snapshot')
  }
}

function reportMarker(repository, pullRequest) {
  return `<!-- ldb-agent-usage-report:${repository}#${pullRequest} -->`
}

function unavailableBody(marker, pullRequest, reason) {
  const unavailableReportBody = [
    marker,
    '## Agent 사용량 보고',
    '',
    `PR #${pullRequest}의 사용량을 보고할 수 없습니다: ${reason}`,
    '수치를 추정하지 않았습니다. Snapshot을 갱신한 뒤 workflow를 다시 실행해 주세요.'
  ].join('\n')
  return unavailableReportBody
}

function latestTrustedSnapshot(comments, trusted) {
  const candidates = comments
    .filter((comment) => {
      const isBodyString = typeof comment.body === 'string'
      const hasSnapshotMarker = isBodyString && comment.body.includes(SNAPSHOT_MARKER)
      const isTrustedSnapshot =
        hasSnapshotMarker && trusted.has(commentAuthor(comment)?.toLowerCase())
      return isTrustedSnapshot
    })
    .sort(
      (left, right) =>
        Date.parse(right.updated_at ?? right.created_at ?? 0) -
        Date.parse(left.updated_at ?? left.created_at ?? 0)
    )
  const hasNoCandidates = candidates.length === 0
  if (hasNoCandidates) {
    return { reason: '신뢰할 수 있는 snapshot이 없습니다.' }
  }
  try {
    return { snapshot: parseSnapshotComment(candidates[0].body) }
  } catch {
    return { reason: '최신 snapshot의 형식이 올바르지 않습니다.' }
  }
}

export function publishReport(repository, number, call = ghJson) {
  try {
    const pr = getPullRequest(repository, number, call)
    const hasRequestedNumber = pr.number === number
    const isMerged = hasRequestedNumber && pr.state === 'MERGED'
    const mergedAt = isMerged ? pr.mergedAt : undefined
    const hasMergeTime =
      mergedAt != null &&
      mergedAt !== '' &&
      mergedAt !== false &&
      mergedAt !== 0 &&
      mergedAt !== 0n &&
      !Number.isNaN(mergedAt)
    const isPublishablePullRequest = hasMergeTime && pr.isCrossRepository === false
    if (!isPublishablePullRequest) {
      return { status: 'skipped', issues: [] }
    }
    const issues = linkedIssues(pr, repository)
    const hasNoLinkedIssues = issues.length === 0
    if (hasNoLinkedIssues) {
      return { status: 'skipped', issues: [] }
    }

    const actor = currentActor(call)
    const comments = listComments(repository, number, call)
    const owner = repository.split('/')[0].toLowerCase()
    const trusted = new Set(
      [owner, pr.author?.login?.toLowerCase()].filter((login) => {
        const isFalsyIdentity =
          login == null ||
          login === '' ||
          login === false ||
          login === 0 ||
          login === 0n ||
          Number.isNaN(login)
        return !isFalsyIdentity
      })
    )
    const selected = latestTrustedSnapshot(comments, trusted)
    const marker = reportMarker(repository, number)
    let status = 'unavailable'
    let body

    const isSnapshotMissing = selected.snapshot == null
    const isSnapshotMismatched =
      !isSnapshotMissing && !matchesSnapshot(selected.snapshot, repository, pr)
    const isManifestIssueUnlinked =
      !isSnapshotMissing &&
      !isSnapshotMismatched &&
      !issues.some(({ number: issue }) => issue === selected.snapshot.issue)
    if (isSnapshotMissing) {
      body = unavailableBody(marker, number, selected.reason)
    } else if (isSnapshotMismatched) {
      body = unavailableBody(
        marker,
        number,
        'snapshot이 현재 PR head 또는 merge 시점과 일치하지 않습니다.'
      )
    } else if (isManifestIssueUnlinked) {
      body = unavailableBody(
        marker,
        number,
        'snapshot의 manifest Issue가 현재 PR에 연결된 Issue가 아닙니다.'
      )
    } else {
      status = selected.snapshot.complete ? 'published' : 'unavailable'
      body = [marker, renderReport(selected.snapshot)].join('\n')
    }

    for (const issue of issues) {
      writeComment(repository, issue.number, body, marker, actor, call)
    }
    return {
      status,
      issues: issues.map(({ number: issue }) => `https://github.com/${repository}/issues/${issue}`)
    }
  } catch {
    throw new Error('Unable to publish usage report')
  }
}
