import { appendFile, readFile } from 'node:fs/promises'

import { POLICY_MARKER, buildPolicySummary, findCommentByMarker } from './comments.mjs'
import { GitHubClient } from './github-client.mjs'
import { buildPolicyReport } from './policy.mjs'
import {
  evaluateTrustedReviewRequest,
  evaluateWorkflowRunSource,
  pullRequestNumber
} from './workflow-run.mjs'

function requiredEnvironment(name) {
  const value = process.env[name]
  const hasEnvironmentValue = value != null
  const isEnvironmentValueEmpty = hasEnvironmentValue && value.length === 0
  const isEnvironmentValueMissingOrEmpty = !hasEnvironmentValue || isEnvironmentValueEmpty
  if (isEnvironmentValueMissingOrEmpty) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

async function writeStepSummary(content) {
  const hasSummaryPath = Boolean(process.env.GITHUB_STEP_SUMMARY)
  if (hasSummaryPath) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${content}\n`)
  }
}

async function main() {
  const eventPath = requiredEnvironment('GITHUB_EVENT_PATH')
  const event = JSON.parse(await readFile(eventPath, 'utf8'))
  const label = process.env.REVIEW_LABEL ?? '@ldb-review'
  const source = evaluateWorkflowRunSource(event)

  if (!source.eligible) {
    const message = `AI review policy skipped: ${source.reason}`
    console.log(message)
    await writeStepSummary(message)
    return
  }

  const client = new GitHubClient({
    token: requiredEnvironment('GITHUB_TOKEN'),
    repository: event.repository.full_name
  })
  const pullRequest = await client.getPullRequest(pullRequestNumber(event))
  const eligibility = evaluateTrustedReviewRequest(event, pullRequest, { label })
  if (!eligibility.eligible) {
    const message = `AI review policy skipped: ${eligibility.reason}`
    console.log(message)
    await writeStepSummary(message)
    return
  }

  const [comments, files, commits] = await Promise.all([
    client.listComments(pullRequest.number),
    client.listFiles(pullRequest.number),
    client.listCommits(pullRequest.number)
  ])
  const automationComments = comments.filter(
    (comment) => comment.user?.login === 'github-actions[bot]'
  )
  const commitFiles = await Promise.all(
    commits.map(async (commit) => ({
      sha: commit.sha,
      files: await client.listCommitFiles(commit.sha)
    }))
  )

  const report = buildPolicyReport({
    pullRequest,
    repositoryOwner: event.repository.owner.login,
    files,
    commits,
    comments,
    commitFiles
  })
  const summary = buildPolicySummary({
    headSha: pullRequest.head.sha,
    checks: report.checks
  })
  const previousSummary = findCommentByMarker(automationComments, POLICY_MARKER)
  const hasPreviousSummary = previousSummary != null
  if (hasPreviousSummary) {
    await client.updateComment(previousSummary.id, summary)
  } else {
    await client.createComment(pullRequest.number, summary)
  }

  await writeStepSummary(summary)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
