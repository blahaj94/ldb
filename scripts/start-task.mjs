import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROJECTS = new Set(['api', 'desktop', 'web', 'ui', 'cross', 'repo'])

function buildTaskContext({ issue, branch, destination, base }) {
  const taskContext = [
    `Issue #${issue.number}: ${issue.title}`,
    issue.url,
    `Branch: ${branch}`,
    `Worktree: ${destination}`,
    `Base: ${base}`,
    '구현 전 Issue 본문과 docs/README.md를 읽고 docs/rules/change-control.md의 preflight·승인을 확인하세요.'
  ].join('\n')

  return taskContext
}

export function startTask(args, run = execFileSync) {
  const [project, issueNumber, description, worktreePath] = args
  const hasExpectedArgumentCount = args.length === 4
  const isProjectAllowed = PROJECTS.has(project)
  const hasIssueNumberFormat = /^[1-9]\d*$/.test(issueNumber ?? '')
  const isIssueNumberSafeInteger = Number.isSafeInteger(Number(issueNumber))
  const isIssueNumberTrimmed = issueNumber === issueNumber?.trim()
  const hasDescriptionFormat = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(description ?? '')
  const isDescriptionTrimmed = description === description?.trim()
  const hasWorktreePath = (worktreePath?.trim().length ?? 0) > 0
  const isInputValid =
    hasExpectedArgumentCount &&
    isProjectAllowed &&
    hasIssueNumberFormat &&
    isIssueNumberSafeInteger &&
    isIssueNumberTrimmed &&
    hasDescriptionFormat &&
    isDescriptionTrimmed &&
    hasWorktreePath
  if (!isInputValid) {
    throw new Error(
      '사용법: pnpm start-task <project: api|desktop|web|ui|cross|repo> <Issue 번호> <description: 소문자-작업-설명> <새 worktree 경로>'
    )
  }

  const destination = resolve(worktreePath)
  const isDestinationPresent = existsSync(destination)
  if (isDestinationPresent) {
    throw new Error(`이미 존재하는 경로입니다: ${destination}`)
  }

  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  const issue = JSON.parse(
    run('gh', ['issue', 'view', issueNumber, '--json', 'number,title,url,state'], options)
  )
  const isIssueNumberMatching = issue.number === Number(issueNumber)
  const isIssueOpen = issue.state === 'OPEN'
  const isIssueEligible = isIssueNumberMatching && isIssueOpen
  if (!isIssueEligible) {
    throw new Error(`현재 repository의 OPEN Issue #${issueNumber}가 필요합니다.`)
  }

  run('git', ['fetch', 'origin', 'main'], options)
  const base = run('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], options).trim()
  const branch = `${project}-${issueNumber}-${description}`
  run('git', ['worktree', 'add', '-b', branch, destination, base], options)

  const context = buildTaskContext({ issue, branch, destination, base })

  return context
}

const entryPath = process.argv[1]
const hasEntryPath = entryPath != null
if (hasEntryPath) {
  const hasNonEmptyEntryPath = entryPath !== ''
  if (hasNonEmptyEntryPath) {
    const isDirectRun = import.meta.url === pathToFileURL(resolve(entryPath)).href
    if (isDirectRun) {
      try {
        console.log(startTask(process.argv.slice(2)))
      } catch (error) {
        console.error(error.message)
        process.exitCode = 1
      }
    }
  }
}
