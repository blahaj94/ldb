import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { catalogSessions, collectUsage, readSession } from './agent-usage/collect.mjs';
import { ghJson, getPullRequest, saveSnapshot, publishReport } from './agent-usage/github.mjs';
import { renderReport, validateSnapshot } from './agent-usage/report.mjs';

function number(value) {
  if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
    throw new Error('양의 정수 Issue/PR 번호가 필요합니다.');
  }
  return Number(value);
}

async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

export async function runUsage(args, { cwd = process.cwd(), env = process.env, call = ghJson, write = console.log } = {}) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    repo: { type: 'string' }, issue: { type: 'string' }, pr: { type: 'string' },
    thread: { type: 'string' }, 'from-turn': { type: 'string' }, 'through-turn': { type: 'string' },
    until: { type: 'string' }, 'exclude-turn': { type: 'string', multiple: true },
    'sessions-dir': { type: 'string' }, publish: { type: 'boolean' }, json: { type: 'boolean' },
    refresh: { type: 'boolean' }
  } });
  const [command] = positionals;
  if (positionals.length !== 1 || !['begin', 'snapshot', 'publish', 'turns'].includes(command)) {
    throw new Error('사용법: node scripts/agent-usage.mjs begin|snapshot|publish|turns [options]');
  }
  const requestedRepository = values.repo ?? call(['repo', 'view', '--json', 'nameWithOwner'])?.nameWithOwner;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(requestedRepository ?? '')) throw new Error('Repository를 확인할 수 없습니다.');
  const repository = requestedRepository.toLowerCase();
  if (command === 'publish') {
    const result = publishReport(repository, number(values.pr), call);
    write(JSON.stringify(result));
    return result.status === 'unavailable' ? 1 : 0;
  }
  const sessions = values['sessions-dir'] ?? join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  const now = new Date().toISOString();
  const git = (arguments_) => execFileSync('git', arguments_, { cwd, encoding: 'utf8' }).trim();
  const state = resolve(cwd, git(['rev-parse', '--git-common-dir']), 'agent-usage');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const catalog = await catalogSessions(sessions);
  const rootLog = async (thread, until = values.until ?? now) => {
    if (!Number.isFinite(Date.parse(until)) || Date.parse(until) > Date.now()) throw new Error('과거 또는 현재의 유효한 종료 시각이 필요합니다.');
    const meta = catalog.get(thread);
    if (!meta || meta.parent) throw new Error('Root task log가 필요합니다. --thread를 확인하세요.');
    return readSession(meta.file, until);
  };
  if (command === 'turns') {
    const log = await rootLog(values.thread ?? env.CODEX_THREAD_ID);
    write(JSON.stringify(log.turns.map((turn) => ({ ...turn, ...log.contexts.get(turn.id) })), null, 2));
    return 0;
  }
  const issue = number(values.issue);
  const manifestFile = join(state, `issue-${issue}.json`);
  const manifests = await Promise.all((await readdir(state)).filter((file) => /^issue-\d+\.json$/.test(file))
    .map(async (file) => JSON.parse(await readFile(join(state, file), 'utf8'))));
  const existing = manifests.find((entry) => entry.issue === issue);
  const sameRepository = typeof existing?.repository === 'string' && existing.repository.toLowerCase() === repository;
  if (command === 'begin') {
    const thread = values.thread ?? env.CODEX_THREAD_ID;
    const log = await rootLog(thread);
    const fromTurn = values['from-turn'] ?? log.turns.at(-1)?.id;
    if (!fromTurn || !log.turns.some((turn) => turn.id === fromTurn)) throw new Error('시작 turn을 확인할 수 없습니다.');
    const manifest = { schemaVersion: 1, repository, issue, thread, fromTurn };
    if (existing && (!sameRepository || ['thread', 'fromTurn'].some((key) => existing[key] !== manifest[key]))) {
      throw new Error('이미 기록된 작업 시작 범위를 덮어쓸 수 없습니다.');
    }
    if (manifests.some((entry) => entry.issue !== issue && entry.thread === thread && entry.fromTurn === fromTurn)) {
      throw new Error('다른 Issue와 시작 turn이 겹칩니다. 작업 범위를 분리하세요.');
    }
    if (!existing) await writeJson(manifestFile, manifest);
    write(`Issue #${issue}의 작업 시작 범위를 기록했습니다.`);
    return 0;
  }
  if (!existing || existing.schemaVersion !== 1 || !sameRepository) {
    throw new Error('해당 Issue의 local 작업 기록이 없습니다. 먼저 begin을 실행하세요.');
  }
  const until = values.until ?? (values.refresh ? undefined : existing.until) ?? now;
  const log = await rootLog(existing.thread, until);
  const throughTurn = values['through-turn'] ?? (values.refresh ? undefined : existing.throughTurn) ?? log.turns.at(-1)?.id;
  const first = log.turns.findIndex((turn) => turn.id === existing.fromTurn);
  const last = log.turns.findIndex((turn) => turn.id === throughTurn);
  const excludeTurns = values['exclude-turn'] ?? existing.excludeTurns ?? [];
  if (manifests.some((entry) => {
    const index = log.turns.findIndex((turn) => turn.id === entry.fromTurn);
    return entry.issue !== issue && entry.thread === existing.thread && index >= first && index <= last;
  })) throw new Error('다른 Issue의 작업 시작 범위와 겹칩니다. --through-turn으로 종료를 지정하세요.');
  const pr = getPullRequest(repository, number(values.pr), call);
  if (pr.isCrossRepository !== false || !pr.closingIssuesReferences?.some((entry) =>
    entry.number === issue && `${entry.repository?.owner?.login}/${entry.repository?.name}`.toLowerCase() === repository.toLowerCase())) {
    throw new Error('대상 PR에 연결된 same-repository Issue가 아닙니다.');
  }
  if (pr.state !== 'MERGED' && pr.headRefOid !== git(['rev-parse', 'HEAD'])) {
    throw new Error('Local HEAD와 PR head가 다릅니다. 변경을 push한 뒤 실행하세요.');
  }
  if (pr.mergedAt && Date.parse(until) > Date.parse(pr.mergedAt)) {
    throw new Error('Backfill은 --until에 merge 시각 이전의 집계 종료를 지정하세요.');
  }
  const usage = await collectUsage(sessions, {
    thread: existing.thread, fromTurn: existing.fromTurn, throughTurn, excludeTurns, until
  });
  const snapshot = validateSnapshot({ schemaVersion: 1, repository, issue,
    pullRequest: pr.number, headSha: pr.headRefOid, ...usage });
  await writeJson(join(state, `issue-${issue}.snapshot.json`), snapshot);
  await writeJson(manifestFile, { ...existing, throughTurn, until, excludeTurns });
  write(values.json ? JSON.stringify(snapshot, null, 2) : renderReport(snapshot));
  if (values.publish) write(JSON.stringify(saveSnapshot(snapshot, call)));
  return snapshot.complete ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await runUsage(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : '사용량 command가 실패했습니다.');
    process.exitCode = 1;
  }
}
