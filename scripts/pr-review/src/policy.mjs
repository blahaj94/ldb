const RULE_PATHS = [
  "AGENTS.md",
  "docs/rules/",
  "docs/architecture/",
  "docs/domain/",
];

const LOGIC_EXTENSION = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|cs|php)$/i;
const NON_LOGIC_PATH = /(?:^|\/)(?:test|tests|__tests__|mocks?|fixtures?|generated|dist|build)(?:\/|$)|\.(?:test|spec|mock)\.[^.]+$/i;
const IMPLEMENTATION_COMMIT = /^(?:feat|fix|refactor)(?:\([^)]*\))?!?:/i;
const TEST_COMMIT = /^test(?:\([^)]*\))?!?:/i;

function isRuleFile(filename) {
  return RULE_PATHS.some((path) =>
    path.endsWith("/") ? filename.startsWith(path) : filename === path,
  );
}

function isLogicFile(filename) {
  return LOGIC_EXTENSION.test(filename) && !NON_LOGIC_PATH.test(filename);
}

function subject(commit) {
  return commit.commit?.message?.split("\n", 1)[0]?.trim() ?? "";
}

function linkedIssueCheck(pullRequest) {
  const issue = pullRequest.body?.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|related to)?\s*#(\d+)/i);
  return issue
    ? { name: "linked_issue", status: "pass", detail: `#${issue[1]}` }
    : {
        name: "linked_issue",
        status: "warning",
        detail: "PR body에 linked Issue가 없습니다.",
      };
}

function approvalCheck(files, comments, repositoryOwner) {
  if (!files.some(({ filename }) => isRuleFile(filename))) {
    return {
      name: "rule_approval",
      status: "skipped",
      detail: "Rule 변경 없음",
    };
  }

  const approved = comments.some(
    (comment) =>
      comment.user?.login === repositoryOwner && comment.body?.trim() === "승인",
  );
  return {
    name: "rule_approval",
    status: approved ? "pass" : "warning",
    detail: approved ? "Repository owner 승인 확인" : "Repository owner의 정확한 `승인` comment 필요",
  };
}

function testEvidenceCheck(files, commits) {
  if (!files.some(({ filename }) => isLogicFile(filename))) {
    return {
      name: "test_evidence",
      status: "skipped",
      detail: "Logic 변경 없음",
    };
  }

  const testIndex = commits.findIndex((commit) => TEST_COMMIT.test(subject(commit)));
  const implementationIndex = commits.findIndex((commit) =>
    IMPLEMENTATION_COMMIT.test(subject(commit)),
  );
  const valid = testIndex >= 0 && (implementationIndex < 0 || testIndex < implementationIndex);
  return {
    name: "test_evidence",
    status: valid ? "pass" : "warning",
    detail: valid
      ? "Red test commit이 implementation보다 먼저 존재"
      : "Implementation보다 앞선 Red test commit을 확인할 수 없음",
  };
}

function logicBudgetCheck(files) {
  const lines = files
    .filter(({ filename }) => isLogicFile(filename))
    .reduce((total, file) => total + file.additions + file.deletions, 0);
  return {
    name: "logic_budget",
    status: lines > 300 ? "warning" : "pass",
    detail: `Approximate logic diff: ${lines} lines (soft budget: 300)`,
  };
}

export function buildPolicyReport({
  pullRequest,
  repositoryOwner,
  files,
  commits,
  comments,
}) {
  return {
    advisory: true,
    checks: [
      linkedIssueCheck(pullRequest),
      approvalCheck(files, comments, repositoryOwner),
      testEvidenceCheck(files, commits),
      logicBudgetCheck(files),
    ],
  };
}
