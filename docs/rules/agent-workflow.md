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

## Automation boundary

Dispatch eligibility, dependency scheduling, retry bookkeeping, label transition, stale-head cancellation, deduplication은 입력 contract가 안정된 뒤 deterministic automation으로 옮길 수 있다. v0에서는 existing GitHub workflow와 수동 Issue/PR lifecycle을 사용하며 runtime, dispatcher, queue, model API, automatic merge를 추가하지 않는다.
