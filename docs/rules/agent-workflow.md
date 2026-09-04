---
type: rule
status: active
enforcement: approval-required
scope: repository
last-reviewed: 2026-09-05
rationale: 큰 요청을 작은 GitHub Issue로 분해하고 agent 사이의 context와 비용을 제한한다.
evidence: "GitHub Issue #26"
exceptions: 긴급 작업도 change-control approval boundary와 사용자 merge 권한은 생략하지 않는다.
review-after: Execution Issue 10개 적용 후
---

# Agent Workflow

## 목적

큰 개발 요청을 Planner, Worker, Reviewer가 원래 대화 없이 이어받을 수 있는 작은 task로 바꾼다. GitHub Issue와 Pull Request가 durable coordination artifact이며 conversation history는 source of truth가 아니다.

이 문서는 agent 사이의 handoff contract만 정의한다. Approval, branch, worktree, commit, merge 절차는 [`change-control.md`](change-control.md), test evidence는 [`testing.md`](testing.md), context와 logic budget은 [`code-quality.md`](code-quality.md)를 따른다.

## 역할

### Planner

- 여러 독립 결과나 architecture 판단이 필요한 큰 요청만 분해한다. 이미 bounded한 요청에는 별도 planning 단계를 만들지 않는다.
- Repository Rule과 관련 module을 먼저 확인하고, 각 task를 원래 대화 없이 실행 가능한 Execution Issue로 만든다.
- 같은 core module을 변경하거나 순서가 필요한 task는 병렬화하지 않는다.
- High-capability model은 큰 작업의 decomposition, architecture, security, 높은 uncertainty 판단에 사용한다.

### Worker

- 하나의 Execution Issue만 수행하고 필요한 context를 점진적으로 읽는다.
- Issue 범위, approval boundary, dependency가 충족되었는지 확인한 뒤 [`change-control.md`](change-control.md)의 preflight와 worktree 절차를 따른다.
- Acceptance criteria를 test와 validation evidence로 검증하고 Draft PR로 handoff한다.
- Scope를 임의로 늘리거나 architecture ambiguity를 추측으로 해결하지 않는다.

### Reviewer

- Issue의 acceptance criteria, diff, validation result, concise worker summary를 기준으로 consequential defect를 찾는다.
- Worker의 conversation, 전체 reasoning, shell history를 요구하지 않는다.
- Low-cost first-pass review를 기본으로 하고 아래 escalation 조건에 해당할 때만 high-capability reviewer 또는 사람에게 넘긴다.
- Agent Reviewer는 Approve와 merge를 수행하지 않는다.

## Issue 종류

### Design / RFC Issue

Workflow, Rule, architecture의 대안, trade-off, open question, decision history를 기록한다. 재사용 가치가 있는 Proposal Revision, Decision, Rejected Alternative만 comment로 남기고 모든 reasoning step을 복사하지 않는다.

### Execution Issue

Worker가 원래 사용자 대화 없이 실행할 수 있는 task contract다. 하나의 bounded outcome을 다루며 최소한 다음 정보를 포함한다.

- Goal과 user-visible behavior
- Test 가능한 acceptance criteria
- In scope와 out of scope
- 관련 Rule과 context pointer
- Complexity: `low | medium | high`
- Uncertainty: `low | medium | high`
- Risk: `low | medium | high`
- Worker model tier: `low | standard | high`
- Worker count: 기본값 `1`
- Scout 필요 여부와 조사 범위
- Validation command와 manual evidence
- Dependency: `Blocked by #123`, `Blocks #456` 형식
- Escalation condition

Metadata의 source of truth는 Issue body다. Label은 `@ldb-review`처럼 실제 automation trigger가 있을 때만 사용한다.

## Planning과 dispatch

- Worker count는 `1`이 기본이다. File과 state를 공유하지 않는 독립 task가 명확할 때만 늘린다.
- 단순히 여러 의견을 얻기 위해 같은 implementation을 여러 Worker에게 중복시키지 않는다.
- Uncertainty가 높으면 Worker를 늘리기 전에 좁은 질문과 종료 조건을 가진 low-tier Scout 한 명을 검토한다.
- `low` tier는 repository 탐색, 반복 작업, 단순 refactor와 first-pass review에 사용한다.
- `standard` tier는 명확한 acceptance criteria가 있는 일반 implementation과 test의 기본값이다.
- `high` tier는 큰 작업 planning, architecture/security ambiguity, high-risk final review와 escalation에 사용한다.
- Provider 또는 model 이름은 Issue contract에 고정하지 않는다. 실행 환경이 capability tier를 실제 model에 매핑한다.
- Dependency가 남은 Issue는 dispatch하지 않는다. v0에서는 사람이 GitHub reference를 확인하며 scheduler를 구현하지 않는다.

## Context contract

- Issue에는 긴 source code, repository 전체 요약, conversation transcript를 복사하지 않는다.
- File path, symbol, documentation section, Issue, PR, commit, test를 context pointer로 사용한다.
- Agent는 required document와 직접 관련된 module부터 읽고 필요할 때만 범위를 넓힌다.
- Worker는 지속적인 중간 보고를 기본으로 하지 않는다. Scope, decision, blocker, reusable evidence만 Issue 또는 PR에 남긴다.

## Retry와 escalation

동일한 접근의 Worker retry는 최대 1회다. 두 번째 실패는 접근을 반복하지 않고 사람 또는 Planner에게 escalation한다. Provider/network의 transient retry는 향후 deterministic automation 정책으로 분리한다.

다음 조건에서는 작업을 중단하고 escalation한다.

- Scope expansion 또는 acceptance criteria 충돌
- Rule, architecture, public API, database schema 변경 필요
- Security ambiguity
- Dependency 또는 필요한 context 부재
- 관련 validation 실행 불가
- Configured retry budget 소진

다음 조건에서는 high-capability final review 또는 사람 review가 필요하다.

- Risk가 `high`
- Rule, architecture, API, schema, authentication, authorization 변경
- First-pass review의 P0/P1 finding이 해결되지 않음
- Validation evidence가 불완전함

## PR handoff

Worker의 Draft PR은 다음 정보를 제공한다.

- Related Execution Issue와 acceptance criteria 충족 관계
- Concise implementation summary와 diff
- Test, typecheck, lint, build, manual validation 결과
- 남은 risk와 실행하지 못한 validation
- First-pass reviewer finding과 처리 결과
- Final review escalation 여부와 이유

전체 reasoning history와 shell history는 handoff에 포함하지 않는다.

## PR 사용량 보고

PR이 merge되면 연결된 same-repository Issue에 작업 사용량 보고를 남긴다. 보고는 local에서 수집한 snapshot을 기준으로 하며, merge는 게시 trigger다. GitHub Actions 실행 지연을 허용하고 merge 시점까지의 과금 총액으로 해석하지 않는다.

### 작업 범위와 수집 책임

- Worker는 작업 시작 시 Issue와 root task의 시작 turn을 명시적으로 연결하고, handoff 시 집계 종료 범위를 기록한다. 이 연결 정보는 tracked source 밖의 local manifest에 둔다.
- 같은 대화의 이전 Issue 작업, 보고를 위한 후속 질의, 다른 작업의 subagent turn을 현재 PR 비용에 포함하지 않는다. 작업 범위가 불명확하면 시간 간격이나 대화 내용을 추측해 합산하지 않는다.
- PR을 최종 handoff하기 전에 deterministic command로 사용량 snapshot을 PR comment에 저장한다. 후속 작업으로 PR head가 바뀌면 snapshot도 갱신한다.
- Snapshot에는 대상 PR/head, 집계 범위와 시각, 본 에이전트와 서브 에이전트별 사용량, 실제 모델과 reasoning effort를 기록한다. 같은 agent의 모델 설정 변경도 보존한다.
- Snapshot 이후의 마무리 응답과 보고 자체 사용량은 제외될 수 있으며, 보고서에서 집계 시점을 명시한다.
- Model과 effort는 실행 사실을 보고하기 위한 metadata다. Execution Issue의 worker tier를 특정 provider/model로 고정하는 근거로 사용하지 않는다.

### 집계와 정보 경계

- 집계와 보고서 생성은 dependency 없는 Node.js ESM command로 수행한다. 매번 AI가 raw 로그를 읽거나 임시 script를 작성해 수동 합산하지 않는다.
- 입력, 캐시 입력, 출력, 전체 토큰과 캐시 입력 제외 수치를 구분한다. 출력에 포함된 reasoning 토큰을 다시 더하지 않는다.
- Response별 usage record를 dedup하며 turn/thread 누적 counter를 반복 합산하지 않는다. 대상 root turn과 연결된 descendant만 재귀적으로 포함한다.
- 사용량·모델·descendant 기록 누락, 잘린 로그 또는 검증할 수 없는 범위는 incomplete/unknown으로 표시한다. 누락을 0으로 채우거나 완전한 집계로 보고하지 않는다.
- Raw 대화, reasoning, tool input/output, credential, 개인 filesystem 경로와 내부 task/turn ID는 local에만 둔다. GitHub에는 보고에 필요한 aggregate field만 allowlist로 내보낸다.
- 구체적인 command와 file 위치는 `scripts/README.md`와 `docs/reference/repository-map.md`에서 관리한다.

### Merge 후 게시

- GitHub workflow는 merged 상태와 linked Issue metadata를 확인하고, 검증된 snapshot으로 보고서를 생성한다. 단순 close, fork PR, 다른 repository Issue에는 게시하지 않는다.
- Snapshot의 작성자, schema, 대상 PR과 head를 검증한다. Snapshot 누락·오래된 head·불완전 집계는 보고 불가 또는 불완전 사유를 명시하며 수치를 추정하지 않는다.
- 보고 comment는 PR별 식별자를 사용하며 재실행 시 기존 자동 보고를 갱신한다. 다른 작성자의 comment를 덮어쓰지 않는다.
- Workflow는 trusted default branch code와 필요한 최소 GitHub permission만 사용한다. Local 로그 접근을 위해 새 Secret, 외부 서버 또는 상시 polling process를 추가하지 않는다.
- 보고 실패는 retry 가능한 실행 결과로 남기며 merge를 되돌리거나 AI가 추가 merge를 수행하지 않는다.

## Automation boundary

Dispatch eligibility, dependency scheduling, retry bookkeeping, label transition, stale-head cancellation, deduplication은 입력 contract가 안정된 뒤 deterministic automation으로 옮길 수 있다. v0에서는 existing GitHub workflow와 수동 Issue/PR lifecycle을 사용하며 runtime, dispatcher, queue, model API, automatic merge를 추가하지 않는다.

PR 사용량 수집과 merge 후 보고 게시에는 위 contract에 한해 local command와 GitHub workflow를 사용한다. 이를 agent 실행 scheduler나 model API runtime으로 확장하지 않는다.
