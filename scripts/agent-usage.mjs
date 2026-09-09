import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { catalogSessions, collectUsage, readSession } from './agent-usage/collect.mjs'
import { ghJson, getPullRequest, saveSnapshot, publishReport } from './agent-usage/github.mjs'
import { renderReport, validateSnapshot } from './agent-usage/report.mjs'

function number(value) {
  const hasPositiveIntegerFormat = /^[1-9]\d*$/.test(value ?? '')
  const isSafePositiveInteger = hasPositiveIntegerFormat && Number.isSafeInteger(Number(value))
  if (!isSafePositiveInteger) {
    throw new Error('양의 정수 Issue/PR 번호가 필요합니다.')
  }
  return Number(value)
}

async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  const jsonFileContent = JSON.stringify(value, null, 2) + '\n'
  await writeFile(temporary, jsonFileContent, { mode: 0o600 })
  await rename(temporary, file)
}

export async function runUsage(
  args,
  { cwd = process.cwd(), env = process.env, call = ghJson, write = console.log } = {}
) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      issue: { type: 'string' },
      pr: { type: 'string' },
      thread: { type: 'string' },
      'from-turn': { type: 'string' },
      'through-turn': { type: 'string' },
      until: { type: 'string' },
      'exclude-turn': { type: 'string', multiple: true },
      'sessions-dir': { type: 'string' },
      publish: { type: 'boolean' },
      json: { type: 'boolean' },
      refresh: { type: 'boolean' }
    }
  })
  const [command] = positionals
  const hasOneCommand = positionals.length === 1
  const isKnownCommand =
    hasOneCommand && ['begin', 'snapshot', 'publish', 'turns'].includes(command)
  if (!isKnownCommand) {
    throw new Error('사용법: node scripts/agent-usage.mjs begin|snapshot|publish|turns [options]')
  }
  const requestedRepository =
    values.repo ?? call(['repo', 'view', '--json', 'nameWithOwner'])?.nameWithOwner
  const hasRepositoryFormat = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(requestedRepository ?? '')
  if (!hasRepositoryFormat) {
    throw new Error('Repository를 확인할 수 없습니다.')
  }
  const repository = requestedRepository.toLowerCase()
  const isPublishCommand = command === 'publish'
  if (isPublishCommand) {
    const result = publishReport(repository, number(values.pr), call)
    write(JSON.stringify(result))
    const isReportUnavailable = result.status === 'unavailable'
    return isReportUnavailable ? 1 : 0
  }
  const sessions =
    values['sessions-dir'] ?? join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
  const now = new Date().toISOString()
  const git = (arguments_) => execFileSync('git', arguments_, { cwd, encoding: 'utf8' }).trim()
  const state = resolve(cwd, git(['rev-parse', '--git-common-dir']), 'agent-usage')
  await mkdir(state, { recursive: true, mode: 0o700 })
  const catalog = await catalogSessions(sessions)
  const rootLog = async (thread, until = values.until ?? now) => {
    const isCutoffParseable = Number.isFinite(Date.parse(until))
    const isCutoffInFuture = isCutoffParseable && Date.parse(until) > Date.now()
    const isCutoffInvalid = !isCutoffParseable || isCutoffInFuture
    if (isCutoffInvalid) {
      throw new Error('과거 또는 현재의 유효한 종료 시각이 필요합니다.')
    }
    const meta = catalog.get(thread)
    const hasMetadata = meta != null
    const parent = hasMetadata ? meta.parent : null
    const hasParent = parent != null && parent !== false && parent !== 0 && parent !== ''
    const isRootInvalid = !hasMetadata || hasParent
    if (isRootInvalid) {
      throw new Error('Root task log가 필요합니다. --thread를 확인하세요.')
    }
    return readSession(meta.file, until)
  }
  const isTurnsCommand = command === 'turns'
  if (isTurnsCommand) {
    const log = await rootLog(values.thread ?? env.CODEX_THREAD_ID)
    const turnListJson = JSON.stringify(
      log.turns.map((turn) => ({ ...turn, ...log.contexts.get(turn.id) })),
      null,
      2
    )
    write(turnListJson)
    return 0
  }
  const issue = number(values.issue)
  const manifestFile = join(state, `issue-${issue}.json`)
  const manifests = await Promise.all(
    (await readdir(state))
      .filter((file) => /^issue-\d+\.json$/.test(file))
      .map(async (file) => JSON.parse(await readFile(join(state, file), 'utf8')))
  )
  const existing = manifests.find((entry) => entry.issue === issue)
  const hasRepositoryString = typeof existing?.repository === 'string'
  const sameRepository = hasRepositoryString && existing.repository.toLowerCase() === repository
  const isBeginCommand = command === 'begin'
  if (isBeginCommand) {
    const thread = values.thread ?? env.CODEX_THREAD_ID
    const log = await rootLog(thread)
    const fromTurn = values['from-turn'] ?? log.turns.at(-1)?.id
    const hasFromTurn = fromTurn != null && fromTurn !== ''
    const isFromTurnKnown = hasFromTurn && log.turns.some((turn) => turn.id === fromTurn)
    if (!isFromTurnKnown) {
      throw new Error('시작 turn을 확인할 수 없습니다.')
    }
    const manifest = { schemaVersion: 1, repository, issue, thread, fromTurn }
    const hasExistingManifest = existing != null
    const hasDifferentRepository = hasExistingManifest && !sameRepository
    const hasDifferentStart =
      hasExistingManifest &&
      !hasDifferentRepository &&
      ['thread', 'fromTurn'].some((key) => existing[key] !== manifest[key])
    const wouldOverwriteScope = hasDifferentRepository || hasDifferentStart
    if (wouldOverwriteScope) {
      throw new Error('이미 기록된 작업 시작 범위를 덮어쓸 수 없습니다.')
    }
    const hasOverlappingStart = manifests.some((entry) => {
      const isOtherIssue = entry.issue !== issue
      const hasSameThread = isOtherIssue && entry.thread === thread
      const hasSameStart = hasSameThread && entry.fromTurn === fromTurn
      return hasSameStart
    })
    if (hasOverlappingStart) {
      throw new Error('다른 Issue와 시작 turn이 겹칩니다. 작업 범위를 분리하세요.')
    }
    if (!hasExistingManifest) {
      await writeJson(manifestFile, manifest)
    }
    write(`Issue #${issue}의 작업 시작 범위를 기록했습니다.`)
    return 0
  }
  const hasExistingManifest = existing != null
  const hasSupportedManifest = hasExistingManifest && existing.schemaVersion === 1
  const hasUsableManifest = hasSupportedManifest && sameRepository
  if (!hasUsableManifest) {
    throw new Error('해당 Issue의 local 작업 기록이 없습니다. 먼저 begin을 실행하세요.')
  }
  const requestedUntil = values.until
  const shouldRefreshCutoff = requestedUntil == null && values.refresh === true
  const until = requestedUntil ?? (shouldRefreshCutoff ? undefined : existing.until) ?? now
  const log = await rootLog(existing.thread, until)
  const requestedThroughTurn = values['through-turn']
  const shouldRefreshEndTurn = requestedThroughTurn == null && values.refresh === true
  const throughTurn =
    requestedThroughTurn ??
    (shouldRefreshEndTurn ? undefined : existing.throughTurn) ??
    log.turns.at(-1)?.id
  const first = log.turns.findIndex((turn) => turn.id === existing.fromTurn)
  const last = log.turns.findIndex((turn) => turn.id === throughTurn)
  const excludeTurns = values['exclude-turn'] ?? existing.excludeTurns ?? []
  const hasOverlappingIssue = manifests.some((entry) => {
    const index = log.turns.findIndex((turn) => turn.id === entry.fromTurn)
    const isOtherIssue = entry.issue !== issue
    const hasSameThread = isOtherIssue && entry.thread === existing.thread
    const startsWithinRange = hasSameThread && index >= first
    const overlapsRange = startsWithinRange && index <= last
    return overlapsRange
  })
  if (hasOverlappingIssue) {
    throw new Error('다른 Issue의 작업 시작 범위와 겹칩니다. --through-turn으로 종료를 지정하세요.')
  }
  const pr = getPullRequest(repository, number(values.pr), call)
  const isSameRepositoryPullRequest = pr.isCrossRepository === false
  const hasLinkedIssue =
    isSameRepositoryPullRequest &&
    pr.closingIssuesReferences?.some((entry) => {
      const hasSameIssueNumber = entry.number === issue
      const isSameRepositoryIssue =
        hasSameIssueNumber &&
        `${entry.repository?.owner?.login}/${entry.repository?.name}`.toLowerCase() ===
          repository.toLowerCase()
      return isSameRepositoryIssue
    })
  if (!hasLinkedIssue) {
    throw new Error('대상 PR에 연결된 same-repository Issue가 아닙니다.')
  }
  const isPullRequestUnmerged = pr.state !== 'MERGED'
  const hasUnpushedHead = isPullRequestUnmerged && pr.headRefOid !== git(['rev-parse', 'HEAD'])
  if (hasUnpushedHead) {
    throw new Error('Local HEAD와 PR head가 다릅니다. 변경을 push한 뒤 실행하세요.')
  }
  const mergedAt = pr.mergedAt
  const hasMergeTime =
    mergedAt != null &&
    mergedAt !== '' &&
    mergedAt !== false &&
    mergedAt !== 0 &&
    mergedAt !== 0n &&
    !Number.isNaN(mergedAt)
  const isCutoffAfterMerge = hasMergeTime && Date.parse(until) > Date.parse(pr.mergedAt)
  if (isCutoffAfterMerge) {
    throw new Error('Backfill은 --until에 merge 시각 이전의 집계 종료를 지정하세요.')
  }
  const usage = await collectUsage(sessions, {
    thread: existing.thread,
    fromTurn: existing.fromTurn,
    throughTurn,
    excludeTurns,
    until
  })
  const snapshot = validateSnapshot({
    schemaVersion: 1,
    repository,
    issue,
    pullRequest: pr.number,
    headSha: pr.headRefOid,
    ...usage
  })
  await writeJson(join(state, `issue-${issue}.snapshot.json`), snapshot)
  await writeJson(manifestFile, { ...existing, throughTurn, until, excludeTurns })
  const shouldWriteJson = values.json === true
  const snapshotOutput = shouldWriteJson
    ? JSON.stringify(snapshot, null, 2)
    : renderReport(snapshot)
  write(snapshotOutput)
  const shouldPublish = values.publish === true
  if (shouldPublish) {
    write(JSON.stringify(saveSnapshot(snapshot, call)))
  }
  return snapshot.complete ? 0 : 1
}

const entryPath = process.argv[1]
const hasEntryPath = entryPath != null && entryPath !== ''
const isMainModule =
  hasEntryPath && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMainModule) {
  try {
    process.exitCode = await runUsage(process.argv.slice(2))
  } catch (error) {
    const isError = error instanceof Error
    console.error(isError ? error.message : '사용량 command가 실패했습니다.')
    process.exitCode = 1
  }
}
