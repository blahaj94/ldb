const LOGIC_EXTENSION = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|cs|php)$/i
const NON_LOGIC_PATH =
  /(?:^|\/)(?:test|tests|__tests__|mocks?|fixtures?|generated|dist|build)(?:\/|$)|\.(?:test|spec|mock)\.[^.]+$/i
const IMPLEMENTATION_COMMIT = /^(?:feat|fix|refactor)(?:\([^)]*\))?!?:/i
const TEST_COMMIT = /^test(?:\([^)]*\))?!?:/i

function isLogicFile(filename) {
  const hasLogicExtension = LOGIC_EXTENSION.test(filename)
  if (!hasLogicExtension) {
    return false
  }

  const isNonLogicPath = NON_LOGIC_PATH.test(filename)
  const isLogicPath = !isNonLogicPath
  return isLogicPath
}

function subject(commit) {
  const firstLine = commit.commit?.message?.split('\n', 1)[0]
  return firstLine?.trim() ?? ''
}

function linkedIssueCheck(pullRequest) {
  const issue = pullRequest.body?.match(
    /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|related to)?\s*#(\d+)/i
  )
  const hasLinkedIssue = issue != null
  if (hasLinkedIssue) {
    return { name: 'linked_issue', status: 'pass', detail: `#${issue[1]}` }
  }

  return {
    name: 'linked_issue',
    status: 'warning',
    detail: 'PR body에 linked Issue가 없습니다.'
  }
}

function testEvidenceCheck(files, commits) {
  const hasLogicFileChange = files.some(({ filename }) => isLogicFile(filename))
  if (!hasLogicFileChange) {
    return {
      name: 'test_evidence',
      status: 'skipped',
      detail: 'Logic 변경 없음'
    }
  }

  const testIndex = commits.findIndex((commit) => {
    const isTestCommit = TEST_COMMIT.test(subject(commit))
    return isTestCommit
  })
  const implementationIndex = commits.findIndex((commit) => {
    const isImplementationCommit = IMPLEMENTATION_COMMIT.test(subject(commit))
    return isImplementationCommit
  })
  const hasRedTestCommit = testIndex >= 0
  const hasImplementationCommit = implementationIndex >= 0
  const redTestPrecedesImplementation = testIndex < implementationIndex
  const hasValidTestEvidence =
    hasRedTestCommit && (!hasImplementationCommit || redTestPrecedesImplementation)
  return {
    name: 'test_evidence',
    status: hasValidTestEvidence ? 'pass' : 'warning',
    detail: hasValidTestEvidence
      ? 'Red test commit이 implementation보다 먼저 존재'
      : 'Implementation보다 앞선 Red test commit을 확인할 수 없음'
  }
}

function logicLines(files) {
  const logicFiles = files.filter(({ filename }) => isLogicFile(filename))
  return logicFiles.reduce((total, file) => total + file.additions + file.deletions, 0)
}

function logicBudgetCheck(files, commitFiles) {
  const commitFileCount = commitFiles?.length
  const hasCommitFileCount = commitFileCount != null
  let changes
  if (hasCommitFileCount) {
    const hasCommitFileGroups = Boolean(commitFileCount)
    if (hasCommitFileGroups) {
      changes = commitFiles
    } else {
      changes = [{ sha: 'whole PR fallback', files }]
    }
  } else {
    changes = [{ sha: 'whole PR fallback', files }]
  }
  const largest = changes
    .map(({ sha, files: changedFiles }) => ({ sha, lines: logicLines(changedFiles) }))
    .sort((left, right) => right.lines - left.lines)[0]
  const exceedsLogicBudget = largest.lines > 300
  return {
    name: 'logic_budget',
    status: exceedsLogicBudget ? 'warning' : 'pass',
    detail: `Largest approximate logic diff: ${largest.lines} lines in ${largest.sha.slice(0, 12)} (soft budget: 300 per commit)`
  }
}

export function buildPolicyReport({ pullRequest, files, commits, commitFiles }) {
  return {
    advisory: true,
    checks: [
      linkedIssueCheck(pullRequest),
      testEvidenceCheck(files, commits),
      logicBudgetCheck(files, commitFiles)
    ]
  }
}
