import { execFileSync } from "node:child_process";

import {
  SNAPSHOT_MARKER,
  parseSnapshotComment,
  renderReport,
  snapshotComment,
  validateSnapshot,
} from "./report.mjs";

const PR_FIELDS = [
  "number",
  "url",
  "state",
  "mergedAt",
  "headRefOid",
  "isCrossRepository",
  "author",
  "closingIssuesReferences",
].join(",");

export function ghJson(args, body) {
  try {
    const output = execFileSync("gh", args, {
      encoding: "utf8",
      ...(body === undefined ? {} : { input: JSON.stringify(body) }),
    });
    return output.trim() ? JSON.parse(output) : null;
  } catch {
    throw new Error("GitHub CLI request failed");
  }
}

export function getPullRequest(repository, number, call = ghJson) {
  return call(["pr", "view", String(number), "--repo", repository, "--json", PR_FIELDS]);
}

function sameRepository(reference, repository) {
  const [owner, name] = repository.toLowerCase().split("/");
  return reference?.repository?.owner?.login?.toLowerCase() === owner
    && reference?.repository?.name?.toLowerCase() === name;
}

function linkedIssues(pr, repository) {
  const seen = new Set();
  return (pr.closingIssuesReferences ?? []).filter((reference) => {
    if (!sameRepository(reference, repository) || !Number.isSafeInteger(reference.number) || reference.number < 1) return false;
    if (seen.has(reference.number)) return false;
    seen.add(reference.number);
    return true;
  });
}

function currentActor(call) {
  if (process.env.GITHUB_ACTIONS === "true") return "github-actions[bot]";
  const actor = call(["api", "user"]);
  if (typeof actor?.login !== "string") throw new Error("Actor unavailable");
  return actor.login;
}

function listComments(repository, number, call) {
  const result = call([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/issues/${number}/comments`,
  ]);
  if (!Array.isArray(result)) throw new Error("Comments unavailable");
  return result.flat();
}

function commentAuthor(comment) {
  return comment?.user?.login ?? comment?.author?.login;
}

function writeComment(repository, number, body, marker, actor, call) {
  const comments = listComments(repository, number, call);
  const own = comments.find((comment) =>
    typeof comment.body === "string"
    && comment.body.includes(marker)
    && commentAuthor(comment)?.toLowerCase() === actor.toLowerCase());
  if (own) {
    call([
      "api", "--method", "PATCH", `repos/${repository}/issues/comments/${own.id}`, "--input", "-",
    ], { body });
    return { status: "updated" };
  }
  call([
    "api", "--method", "POST", `repos/${repository}/issues/${number}/comments`, "--input", "-",
  ], { body });
  return { status: "created" };
}

function matchesSnapshot(snapshot, repository, pr) {
  return snapshot.repository.toLowerCase() === repository.toLowerCase()
    && snapshot.pullRequest === pr.number
    && snapshot.headSha.toLowerCase() === pr.headRefOid?.toLowerCase()
    && (!pr.mergedAt || Date.parse(snapshot.period.capturedAt) <= Date.parse(pr.mergedAt));
}

export function saveSnapshot(value, call = ghJson) {
  try {
    const snapshot = validateSnapshot(value);
    const pr = getPullRequest(snapshot.repository, snapshot.pullRequest, call);
    const issueIsLinked = linkedIssues(pr, snapshot.repository)
      .some(({ number }) => number === snapshot.issue);
    if (pr.number !== snapshot.pullRequest
      || pr.isCrossRepository !== false
      || !issueIsLinked
      || !matchesSnapshot(snapshot, snapshot.repository, pr)) {
      throw new Error("Ineligible snapshot");
    }
    const actor = currentActor(call);
    return writeComment(
      snapshot.repository,
      snapshot.pullRequest,
      snapshotComment(snapshot),
      SNAPSHOT_MARKER,
      actor,
      call,
    );
  } catch {
    throw new Error("Unable to save usage snapshot");
  }
}

function reportMarker(repository, pullRequest) {
  return `<!-- ldb-agent-usage-report:${repository}#${pullRequest} -->`;
}

function unavailableBody(marker, pullRequest, reason) {
  return [
    marker,
    "## Agent 사용량 보고",
    "",
    `PR #${pullRequest}의 사용량을 보고할 수 없습니다: ${reason}`,
    "수치를 추정하지 않았습니다. Snapshot을 갱신한 뒤 workflow를 다시 실행해 주세요.",
  ].join("\n");
}

function latestTrustedSnapshot(comments, trusted) {
  const candidates = comments
    .filter((comment) => typeof comment.body === "string"
      && comment.body.includes(SNAPSHOT_MARKER)
      && trusted.has(commentAuthor(comment)?.toLowerCase()))
    .sort((left, right) => Date.parse(right.created_at ?? 0) - Date.parse(left.created_at ?? 0));
  if (candidates.length === 0) return { reason: "신뢰할 수 있는 snapshot이 없습니다." };
  try {
    return { snapshot: parseSnapshotComment(candidates[0].body) };
  } catch {
    return { reason: "최신 snapshot의 형식이 올바르지 않습니다." };
  }
}

export function publishReport(repository, number, call = ghJson) {
  try {
    const pr = getPullRequest(repository, number, call);
    if (pr.number !== number || pr.state !== "MERGED" || !pr.mergedAt || pr.isCrossRepository !== false) {
      return { status: "skipped", issues: [] };
    }
    const issues = linkedIssues(pr, repository);
    if (issues.length === 0) return { status: "skipped", issues: [] };

    const actor = currentActor(call);
    const comments = listComments(repository, number, call);
    const owner = repository.split("/")[0].toLowerCase();
    const trusted = new Set([owner, pr.author?.login?.toLowerCase()].filter(Boolean));
    const selected = latestTrustedSnapshot(comments, trusted);
    const marker = reportMarker(repository, number);
    let status = "unavailable";
    let body;

    if (!selected.snapshot) {
      body = unavailableBody(marker, number, selected.reason);
    } else if (!matchesSnapshot(selected.snapshot, repository, pr)) {
      body = unavailableBody(marker, number, "snapshot이 현재 PR head 또는 merge 시점과 일치하지 않습니다.");
    } else {
      status = selected.snapshot.complete ? "published" : "unavailable";
      body = [marker, renderReport(selected.snapshot)].join("\n");
    }

    for (const issue of issues) {
      writeComment(repository, issue.number, body, marker, actor, call);
    }
    return { status, issues: issues.map(({ number: issue }) => `https://github.com/${repository}/issues/${issue}`) };
  } catch {
    throw new Error("Unable to publish usage report");
  }
}
