import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function startTask(args, run = execFileSync) {
  const [issueNumber, worktreePath] = args
  if (
    args.length !== 2 ||
    !/^[1-9]\d*$/.test(issueNumber ?? '') ||
    !Number.isSafeInteger(Number(issueNumber)) ||
    !worktreePath?.trim()
  ) {
    throw new Error('사용법: pnpm start-task <Issue 번호> <새 worktree 경로>')
  }

  const destination = resolve(worktreePath)
  if (existsSync(destination)) {
    throw new Error(`이미 존재하는 경로입니다: ${destination}`)
  }

  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  const issue = JSON.parse(
    run('gh', ['issue', 'view', issueNumber, '--json', 'number,title,url,state'], options)
  )
  if (issue.number !== Number(issueNumber) || issue.state !== 'OPEN') {
    throw new Error(`현재 repository의 OPEN Issue #${issueNumber}가 필요합니다.`)
  }

  run('git', ['fetch', 'origin', 'main'], options)
  const base = run('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], options).trim()
  const branch = `codex/issue-${issueNumber}`
  run('git', ['worktree', 'add', '-b', branch, destination, base], options)

  return [
    `Issue #${issue.number}: ${issue.title}`,
    issue.url,
    `Branch: ${branch}`,
    `Worktree: ${destination}`,
    `Base: ${base}`,
    '구현 전 Issue 본문과 docs/README.md를 읽고 docs/rules/change-control.md의 preflight·승인을 확인하세요.'
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(startTask(process.argv.slice(2)))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
