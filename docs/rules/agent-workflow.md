---
type: rule
status: active
enforcement: approval-required
scope: repository
last-reviewed: 2026-09-06
rationale: 작은 GitHub Issue의 handoff와 배정·완료를 명확히 하여 중복 착수와 agent 사이의 context·비용을 제한한다.
evidence: "GitHub Issue #26, #44, #79"
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
- Acceptance criteria를 작업 유형에 맞는 validation evidence로 검증하고 Issue 또는 Draft PR로 handoff한다.
- Scope를 임의로 늘리거나 architecture ambiguity를 추측으로 해결하지 않는다.

### Reviewer

- Issue의 acceptance criteria, diff, validation result, concise worker summary를 기준으로 consequential defect를 찾는다.
- Worker의 conversation, 전체 reasoning, shell history를 요구하지 않는다.
- Low-cost first-pass review를 기본으로 하고 아래 escalation 조건에 해당할 때만 high-capability reviewer 또는 사람에게 넘긴다.
- Agent Reviewer는 Approve와 merge를 수행하지 않는다.

## Issue 종류

### Design / RFC Issue

Workflow, Rule, architecture의 대안, trade-off, open question, decision history를 기록한다. 재사용 가치가 있는 Proposal Revision, Decision, Rejected Alternative만 comment로 남기고 모든 reasoning step을 복사하지 않는다.

설계안 작성 자체를 Worker에게 배정하려면 아래 Execution contract의 범위·acceptance criteria·실행 조건을 갖춘 bounded Design task로 구체화한다. 설계 완료와 Rule 승인·구현 허용은 별개다.

### 부모 추적 Issue

여러 자식 작업의 결과와 dependency를 추적한다. 제목이 Execution이어도 부모 전체를 구현 Worker에게 배정하지 않는다. 부모·자식 관계는 실행 순서를 뜻하지 않으며 선행 dependency를 별도로 확인한다. 부모의 완료는 등록된 자식 수가 아니라 부모 자체의 acceptance criteria로 판단한다.

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
- Worker count: `1` 고정 (`worker_count: 1`). 누락되거나 다른 값이면 contract를 정정하기 전 dispatch하지 않는다.
- Scout 필요 여부와 조사 범위
- Validation command와 manual evidence
- Dependency: `Blocked by #123`, `Blocks #456` 형식
- Escalation condition

Metadata의 source of truth는 Issue body다. 현재 작업 유형·상태·실행 조건과 승인 evidence를 한 곳에 모으고, 과거 상태는 comment 이력으로 남긴다. Label은 `@ldb-review`처럼 실제 automation trigger 또는 아래 `in process`·`done` 상태 표시에만 사용한다.

`Ready`·`Blocked`는 Issue body의 실행 조건값으로만 사용하며 GitHub label로 추가하지 않는다. `Ready`는 명시된 단계의 착수 검토 후보, `Blocked`는 미해결 조건이 있음을 뜻한다. 실행 조건은 배정·완료 상태와 별도로 기록하며 실행 허용이나 Rule 승인 evidence를 대신하지 않는다.

## Planning과 dispatch

- Issue당 담당 Worker는 한 명이다. 독립 구현 결과를 병렬화하려면 별도 Issue로 나누며, 같은 Issue의 Scout·Reviewer는 별도 구현 담당자가 아니다.
- 단순히 여러 의견을 얻기 위해 같은 implementation을 여러 Worker에게 중복시키지 않는다.
- Uncertainty가 높으면 좁은 질문과 종료 조건을 가진 low-tier Scout 한 명을 검토한다.
- `low` tier는 repository 탐색, code를 변경하지 않는 반복 작업과 first-pass review에 사용한다. 단순하더라도 code 작성·수정은 배정하지 않는다.
- `standard` tier는 명확한 acceptance criteria가 있는 일반 implementation과 test의 기본값이며, code 작업은 아래 runtime mapping을 따른다.
- `high` tier는 큰 작업 planning, architecture/security ambiguity, high-risk final review와 escalation에 사용한다.
- Provider 또는 model 이름은 Issue contract마다 반복해 고정하지 않는다. 실행 환경은 아래 canonical runtime mapping을 포함한 승인된 기준으로 capability tier를 실제 model에 매핑한다.
- Dependency가 남은 Issue는 dispatch하지 않는다. Native dependency와 Issue body의 reference 및 완료 evidence를 확인하며, 불일치는 배정 전에 정리한다. Dependency 완료, 해당 단계 실행 허용, Rule 승인은 각각 확인한다.

### Code Worker runtime mapping

- Code 작성·수정에는 implementation, bug fix, refactor, test, script와 tooling code가 모두 포함된다.
- Code Worker의 기본 실행 설정은 `gpt-5.6-sol`, reasoning effort `high`다. `standard` tier의 일반 implementation은 이 설정에 매핑하며, 작업이 단순하다는 이유로 `low` tier나 더 낮은 effort에 배정하지 않는다.
- 사용자가 model 또는 effort를 명시하면 그 선택을 우선한다. 다른 model이나 더 높은 effort는 사용자의 명시적 선택 또는 승인된 runtime mapping에 따라 사용할 수 있지만, `gpt-5.6-sol`과 `high` 요청을 자동으로 낮추지 않는다.
- Planner와 Worker는 착수 전에 실제 model과 effort가 선택되었는지 확인한다. 설정을 사용할 수 없거나 확인할 수 없으면 임의로 downgrade하지 않고 가용성 문제를 알리며, 확인하지 못한 설정을 적용했다고 보고하지 않는다.
- 이 mapping은 Issue의 capability tier metadata를 대체하지 않으며 Issue마다 provider/model 이름을 반복해 고정하지 않는다. Model 선택과 관계없이 [`../../convention.md`](../../convention.md), [`testing.md`](testing.md), 이 문서의 review·escalation 기준을 모두 적용한다.

### 배정 책임과 상태

- 사용자가 지정한 repository 전체의 활성 Planner 한 명이 배정과 상태 전이를 순서대로 관리한다. 대화·terminal마다 별도 Planner를 자동으로 두지 않는다. 작은 작업에서는 같은 agent가 Planner와 Worker 역할을 겸할 수 있다.
- Planner 교체는 기존 Planner의 배정 중단과 진행 작업 인계를 확인한 뒤 사용자가 정한다. 담당이 불명확하면 Worker를 새로 배정하지 않는다.
- Worker는 직접 미배정 Issue를 선점하지 않는다. Planner가 배정한 범위만 수행하며 상태 변경과 handoff evidence를 Planner에게 전달한다.
- Label 조회·추가는 동시 선점을 보장하는 기술적 lock이 아니다. 중복 착수 방지는 단일 Planner의 순차 배정과 기존 작업 확인을 전제로 한다.

| Issue 상태 | 의미와 신규 배정 |
| --- | --- |
| Open, 두 상태 label 없음 | 미배정 후보. 작업 유형·기존 진행 기록·실행 조건 확인 후 배정한다. |
| Open, `in process` | 담당 Worker가 배정된 상태. 구현·설계·review·승인·merge 대기·blocker를 포함하며 새 Worker를 배정하지 않는다. |
| `done` 또는 Closed | 신규 배정에서 제외한다. Closed만으로 성공 완료를 추정하지 않는다. |
| 두 상태 label 동시 존재 또는 body·label·evidence 불일치 | 상태 복구 전 배정을 보류한다. |

부모 추적·아직 task contract를 갖추지 않은 RFC·장기 제안은 무라벨이어도 Worker 배정 대상이 아니다. 위 Execution contract를 갖춘 bounded Design task는 본문에 작업 유형과 허용 단계를 명시하고 배정 절차를 따른다.

부모 추적 Issue는 완료 전 `in process`·`done`을 모두 사용하지 않고 body와 자식 Issue pointer로 진행을 추적한다. 부모 자체의 완료 조건을 충족했을 때만 `done`을 붙인다. 부모에게 Worker를 배정하거나 자식의 `in process`를 부모에 복사하지 않는다.

### 배정 절차

1. 최신 Issue body·comment·관련 PR을 읽는다. 기존 담당 기록이나 preflight가 있으면 종료·해제 여부를 확인하며, 무라벨이나 PR 부재만으로 미착수를 추정하지 않는다.
2. 배정 가능한 bounded 작업인지, dependency·단계 허용·필요한 승인이 충족됐는지 확인한다. 같은 core module 또는 공유 state를 변경할 가능성이 있는 작업은 병렬 배정하지 않는다. 진행 중 충돌은 [`change-control.md`](change-control.md)를 따른다.
3. Issue body에 담당 Planner와 배정마다 새로 정한 공개용 Worker 식별자, 현재 상태, 필요한 branch·PR pointer를 기록하고 `in process`를 추가한다. 예를 들어 `issue-123-attempt-1`을 공개 식별자로 사용할 수 있다. GitHub assignee만으로 여러 agent를 구분하지 않는다.
4. Body의 배정 기록과 label이 모두 반영됐음을 재조회로 확인한 뒤 Worker를 시작한다. 쓰기 실패나 결과 불명 상태에서는 dispatch하지 않고 먼저 복구한다. 실제 task/turn ID와 공개 식별자의 연결은 local에만 기록한다.
5. Worker는 착수·재개 전에 자신의 최신 배정이 유효한지 확인하고 기존 preflight·worktree 절차를 따른다. 설계와 구현을 병렬화할 때도 승인된 작업 범위와 file·state가 분리되어야 하며, 이후 공통 Rule·code를 편집하는 단계에서 다시 충돌을 확인한다.

### 완료·중단·재배정

Planner는 완료 evidence와 acceptance criteria를 확인하고 body에 결과를 기록한 뒤 `done`을 추가하고 `in process`를 제거한다. 두 상태 label이 함께 남지 않았는지 확인한다. 정상 완료는 Issue도 닫되, 취소·보류 종료에 `done`을 붙이지 않는다.

| 작업 유형 | `done` 조건 |
| --- | --- |
| 구현 | Acceptance criteria·관련 validation 충족과 구현 PR merge 확인 |
| 설계안 작성 | 약속한 설계안·대안·근거·validation matrix와 acceptance criteria 완료. 후속 구현 승인은 별도 gate |
| Rule 반영까지 포함한 설계 | 해당 범위의 acceptance criteria와 명시적 Rule 승인·PR merge 확인 |
| 부모 추적 | 자식의 완료 evidence와 부모 자체의 전체 acceptance criteria 충족 |

- Agent 응답 종료나 Draft PR 생성만으로 완료 처리하지 않는다. Review·blocker 중에는 담당자와 `in process`를 유지하고 남은 조건을 기록한다.
- 응답 부재나 경과 시간만으로 label을 제거하거나 재배정하지 않는다. 기존 Worker 중단을 확인하고 branch·PR·미완료 변경·남은 작업을 인계한 뒤 기존 배정을 해제한다. 확인할 수 없으면 보류하고 사용자에게 알린다.
- 재배정은 새 공개 식별자로 위 배정 절차를 따른다. 대기열로 돌릴 때도 기존 Worker 중단과 배정 해제를 먼저 기록한 뒤 `in process`를 제거한다. Retry budget은 아래 기준을 유지한다.
- 완료 Issue를 재개하려면 사용자가 재개 범위를 정한 뒤 Planner가 완료 기록과 현재 상태를 구분하고 `done`을 제거한다. Reopen만으로 새 Worker를 시작하지 않는다.

### 기존 Issue에 도입

이 Rule 승인 후 최초 신규 배정 전에 Planner가 기존 Open Issue의 body·preflight·PR과 담당자를 확인한다. 배정 가능한 설계·구현의 진행 작업은 기존 담당을 연결해 `in process`로 표시하고, 부모는 위 부모 추적 규칙을 따른다. 완료·취소·미배정을 구분해 현재 body와 label을 일치시킨다. 오래된 상태 문구는 이력으로 옮기며 실행 허용이나 승인 범위를 새로 만들지 않는다. 확인하지 못한 작업은 미배정으로 간주하지 않는다.

기존 `Ready`·`Blocked` label을 발견하면 dependency·단계 실행 허용·승인 evidence를 확인해 현재 실행 조건을 body에 기록하고, 반영을 확인한 뒤 해당 label을 제거한다. Label만으로 실행 조건을 추정하지 않으며 근거를 확인할 수 없으면 정리와 배정을 보류한다. 이 정리로 담당 배정이나 실행 허용을 변경하지 않는다.

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
- Model과 effort는 실행 사실과 위 runtime mapping 준수 여부를 확인하기 위한 metadata다. Execution Issue의 worker tier를 특정 provider/model로 반복해 고정하는 근거로 사용하지 않는다.

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
