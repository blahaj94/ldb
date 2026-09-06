---
type: rule
status: proposed
enforcement: approval-required
scope: repository
rationale: 한 Issue의 독립 작업을 여러 Worker가 수행할 때 배정·context·통합 상태를 분리해 중복 작업과 stale 결과를 막는다.
evidence: "GitHub Issue #81"
exceptions: 복수 Worker가 이점이 없거나 독립성을 증명할 수 없으면 한 Worker를 사용한다.
review-after: 복수 Worker Execution Issue 5개 적용 후
---

# Agent Execution

## 범위와 권한

이 문서는 [`agent-workflow.md`](agent-workflow.md)의 Execution Issue를 여러 Worker에게 나눌 때의 실행 계약이다. 승인 전에는 이 제안을 실제 배정에 적용하지 않는다. Rule 승인과 구현 허용, 사용자 merge 권한은 [`change-control.md`](change-control.md)를 따른다.

한 Issue의 담당 Planner가 전체 contract와 상태에 단일 책임을 지고, 통합 담당 한 명이 Issue 통합 branch의 정확성을 책임진다. 각 Worker는 배정된 bounded scope와 자신의 branch만 책임진다. 이 구분은 Planner나 통합 담당이 Worker의 누락·충돌을 직접 구현할 권한을 만들지 않는다.

## Worker roster와 상태

Issue body의 현재 roster에는 `worker_count`와 같은 수의 slot을 두고 각각 다음 항목을 기록한다.

- 배정마다 새로 정한 공개용 Worker 식별자
- 서로 겹치지 않는 bounded scope와 out of scope
- Worker 상태
- branch와 기준 commit
- 반환된 result commit 또는 PR, validation과 blocker

실제 task·turn ID와 local worktree path는 local에만 둔다. 담당 Planner, 통합 담당, Issue 통합 branch와 현재 integration head도 body에 기록한다. GitHub assignee만으로 여러 agent나 통합 책임을 구분하지 않는다.

| Worker 상태 | 의미 |
| --- | --- |
| `assigned` | Roster와 Issue 상태를 재조회했고 아직 실행 결과가 없다. |
| `working` | 유효한 배정과 기준 commit에서 작업 중이다. |
| `waiting` | 명시된 dependency·결정·환경을 기다리며 배정 책임은 유지한다. |
| `handed-off` | Result commit과 validation을 반환했지만 현재 integration head에 채택되지는 않았다. |
| `integrated` | 통합 담당이 현재 integration head에 결과를 채택하고 필요한 검증을 확인했다. |
| `stopped` / `failed` | 더는 유효한 결과를 만들 수 없다. 중단·실패 evidence와 인계 범위를 남긴다. |

`worker_count`의 의미는 [`agent-workflow.md`](agent-workflow.md)를 따른다. 현재 값은 roster slot 수와 일치해야 하고 `handed-off`·`integrated` scope도 후속 수정 책임과 Issue 이력을 위해 전체 완료까지 남는다. 계획에서 scope를 추가·제거하거나 재배정할 때 body의 count와 roster를 함께 갱신하고 이전 값은 comment 이력으로 남긴다.

Issue label은 Worker 상태와 분리한다.

| Issue 상태 | 의미와 신규 배정 |
| --- | --- |
| Open, 두 상태 label 없음 | 미배정 후보. Contract·기존 진행 기록·실행 조건을 확인한다. |
| Open, `in process` | Worker 작업, 부분 통합, review, blocker, Rule 승인 또는 merge 대기를 포함한다. 최신 roster에 없는 Worker를 시작하지 않는다. |
| `done` 또는 Closed | 신규 배정에서 제외한다. Closed만으로 성공 완료를 추정하지 않는다. |
| 두 상태 label 동시 존재 또는 body·label·evidence 불일치 | 상태 복구 전 배정을 보류한다. |

한 Worker의 응답 종료, `handed-off`·`integrated`, Draft PR 생성이나 일부 acceptance criteria 충족은 Issue 완료가 아니다.

부모 추적 Issue나 아직 Execution contract가 없는 RFC는 무라벨이어도 배정 후보가 아니다. 부모 추적 Issue는 진행 중 `in process`를 사용하지 않고 body와 자식 pointer로 상태를 추적하며, 부모 자체의 완료 조건을 충족할 때만 `done`을 붙인다.

## 배정 절차

단일 Planner는 다음 순서를 배정마다 직렬로 수행한다.

1. 최신 Issue body·comment·관련 PR, 기존 담당과 preflight를 읽는다.
2. Bounded scope, dependency·단계 허용·승인, 기존 실행과의 file·semantic·shared state 충돌을 확인한다.
3. 현재 roster, `worker_count`, 공개 식별자, 통합 담당·branch·head와 `in process` label을 갱신한다.
4. Body와 label을 다시 조회해 모두 반영됐고 상충하는 새 배정이 없는지 확인한다.
5. Worker에게 실행 contract를 전달한다. 쓰기 실패나 결과 불명 상태에서는 dispatch하지 않고 먼저 복구한다.
6. Worker는 착수·재개 전에 자신의 공개 식별자·scope·base가 최신 roster와 일치하는지 확인한다.

Body·label 조회와 수정은 기술적인 atomic lock이 아니다. 중복 착수 방지는 단일 Planner의 순차 기록·재조회와 기존 Worker 상태 확인을 전제로 한다. Worker는 미배정 scope를 선점하지 않는다.

Planner 교체는 기존 Planner의 배정 중단과 진행 roster 인계를 확인한 뒤 사용자가 정한다. 담당이 불명확하면 Worker를 새로 배정하지 않는다. Issue 전체나 scope의 dependency가 남아 있으면 해당 Worker를 dispatch하지 않으며 dependency 완료, 단계 실행 허용과 Rule 승인을 각각 확인한다.

## 병렬 가능성

전체 목표나 독립적인 완료 기준이 다르면 별도 Issue를 사용한다. 한 bounded outcome 안에서는 다음 조건을 모두 만족하는 scope만 병렬로 dispatch한다.

- 각 scope의 입력·산출물·acceptance criteria와 통합 순서를 설명할 수 있다.
- 서로의 미완료 결과를 입력으로 요구하지 않는다.
- 같은 file을 수정하지 않으며, 서로 다른 file이어도 같은 public contract, generated source와 artifact, database, migration, lock, fixture, snapshot이나 외부 shared state를 상충하게 변경하지 않는다.
- 실행 환경의 port, database, filesystem output과 다른 mutable resource를 격리하거나 순차화할 수 있다.
- 승인되지 않은 Rule·architecture·behavior를 가정하지 않는다.
- 같은 변경을 중복 구현하거나 결과를 경주시키지 않는다.

Dependency가 있거나 위 독립성을 증명할 수 없으면 선행 결과를 integration head에 반영하고 검증한 뒤 후속 scope를 배정한다. [`testing.md`](testing.md)의 Red-Green 단계도 이 선후 dependency로 취급하고 선행 Red가 통합·검증되기 전에는 Green scope를 dispatch하지 않는다.

File 이름만으로 충돌을 판단하지 않는다. Public type·API, schema, generated artifact와 shared state의 producer·consumer 관계까지 확인한다. 진행 중 새 dependency나 충돌을 발견하면 영향받는 scope를 멈추고 roster와 통합 순서를 갱신한다.

## Handoff와 context

새 Worker에게는 다음 실행 contract만 필요한 만큼 전달한다.

- Bounded scope, out of scope와 확정된 acceptance criteria
- 승인된 결정과 미결정 escalation boundary
- 관련 Rule, file path, symbol, Issue·PR·commit·test pointer
- 정확한 기준 commit과 선행 결과·통합 순서
- Validation command와 manual evidence
- 반환 형식: result commit, 변경 file, validation 결과, 남은 risk·blocker

전체 원 대화, repository 요약, source 전문, reasoning과 raw tool log를 기본으로 복제하지 않는다. Worker가 context 부족을 발견하면 필요한 pointer나 결정만 요청하고 Planner는 변경된 정보만 보충한다.

같은 scope의 수정·추가 검증이 필요하고 기존 Worker의 배정과 context가 여전히 유효하면 그 Worker를 재사용한다. 새 Worker를 만들어 재탐색시키지 않는다. 기존 Worker가 중단됐거나 base·contract가 무효가 된 경우에는 중단과 인계를 확인한 뒤 재배정 절차를 따른다.

## Branch와 통합

Branch·worktree의 생성과 충돌 처리는 [`change-control.md`](change-control.md)를 따른다. 통합 담당은 Worker result마다 다음을 확인한다.

1. 공개 식별자, scope, result commit과 validation이 최신 roster와 일치한다.
2. 기준 commit이 기록과 일치하고 result가 승인된 scope만 변경한다.
3. 기준 commit 이후 integration head의 변경이 file, public contract, generated artifact, test 의미나 shared state에 영향을 주는지 검토한다.
4. 유효한 result를 정해진 순서로 반영하고 현재 head에서 필요한 validation을 실행한다.
5. 채택된 exact result, integration head와 validation evidence를 Planner에게 반환한다.

Issue body와 label은 Planner만 갱신하고 재조회한다. 통합 담당과 Worker는 상태·result evidence를 Planner에게 반환하며 roster를 직접 수정하지 않는다.

Integration head가 전진했다면 textual conflict가 없다는 이유만으로 result를 채택하지 않는다. 관련 의미가 바뀌었으면 같은 Worker가 최신 head에서 rebase 또는 재작업하고 관련 validation을 다시 실행한다. 통합 담당은 stale 결과를 추측으로 보정하지 않는다.

예상하지 못한 semantic·logic conflict나 scope 누락은 [`change-control.md`](change-control.md)에 따라 영향받는 scope를 멈추고 Planner와 사용자에게 보고한다. 필요한 승인과 범위 판단 전에는 통합 담당이나 Worker가 임의로 해결하지 않는다.

## 진행, 대기와 완료

Planner는 준비된 독립 scope를 먼저 배정하고, 완료된 result부터 검토·통합한다. 실제 가용 실행 slot과 독립 작업이 있을 때만 Worker를 추가하며 `worker_count`를 처리량 목표로 사용하지 않는다.

다른 조정 작업이 있으면 결과가 필요해질 때까지 진행한다. 할 일이 없으면 event 기반 wait를 사용한다. 반복 polling, 변화 없는 상태 보고, 같은 diff 재검토와 직접 구현으로 대기 시간을 채우지 않는다.

Planner는 모든 Worker result의 채택 또는 명시적 제외, 통합 head validation, review, approval과 merge 등 Issue 유형별 완료 조건을 확인한 뒤에만 body에 최종 evidence를 기록하고 `done`을 추가하며 `in process`를 제거한다. 정상 완료는 Issue도 닫는다. 취소·보류 종료에는 `done`을 붙이지 않는다.

| 작업 유형 | `done` 조건 |
| --- | --- |
| 구현 | 전체 acceptance criteria·통합 head validation 충족과 구현 PR merge 확인 |
| 설계안 작성 | 전체 acceptance criteria와 약속한 설계안·대안·근거·validation matrix 완료. 후속 구현 승인은 별도 gate |
| Rule 반영까지 포함한 설계 | 전체 acceptance criteria, 명시적 Rule 승인과 PR merge 확인 |
| 부모 추적 | 자식 evidence와 부모 자체의 전체 acceptance criteria 충족 |

완료 Issue를 재개하려면 사용자가 재개 범위를 정한 뒤 Planner가 이전 완료 evidence와 현재 roster를 구분하고 `done`을 제거한다. Reopen만으로 Worker를 시작하지 않는다.

## 중단·재배정과 retry

응답 부재나 경과 시간만으로 배정을 해제하지 않는다. 기존 Worker 중단을 확인하고 branch·result·미완료 변경·검증·남은 작업을 인계한 뒤 해당 roster slot을 해제한다. 확인할 수 없으면 보류하고 사용자에게 알린다.

재배정은 새 공개 식별자를 사용하고 최신 base·contract로 배정 절차 전체를 반복한다. 이전 Worker의 상태와 결과는 이력에 남기되 최신 roster에서 유효한 담당으로 표시하지 않는다. 이전 Worker의 늦은 결과는 자동 채택하지 않고 현재 배정·base와 비교해 명시적으로 폐기하거나 새 담당 범위로 다시 검증한다.

동일한 접근의 Worker retry는 최대 1회다. 재배정해도 Issue의 기존 retry budget과 실패 evidence를 그대로 이관한다. 두 번째 실패는 접근을 반복하지 않고 Planner 또는 사람에게 escalation한다. Provider/network의 transient retry automation은 별도 승인 범위다.

## PR handoff

통합된 Draft PR은 관련 Issue와 acceptance criteria, Worker별 채택 result, concise final diff, validation, 남은 risk, review finding과 escalation 여부를 제공한다. 전체 reasoning과 shell history는 포함하지 않는다.

## PR 사용량 보고

PR이 merge되면 연결된 same-repository Issue에 작업 사용량 보고를 남긴다. 보고는 local에서 수집한 snapshot을 기준으로 하며, merge는 게시 trigger다. GitHub Actions 실행 지연을 허용하고 merge 시점까지의 과금 총액으로 해석하지 않는다.

### 작업 범위와 수집 책임

- Worker는 작업 시작 시 Issue와 root task의 시작 turn을 명시적으로 연결하고, handoff 시 집계 종료 범위를 기록한다. 이 연결 정보는 tracked source 밖의 local manifest에 둔다.
- 같은 대화의 이전 Issue 작업, 보고를 위한 후속 질의, 다른 작업의 subagent turn을 현재 PR 비용에 포함하지 않는다. 작업 범위가 불명확하면 시간 간격이나 대화 내용을 추측해 합산하지 않는다.
- PR을 최종 handoff하기 전에 deterministic command로 사용량 snapshot을 PR comment에 저장한다. 후속 작업으로 PR head가 바뀌면 snapshot도 갱신한다.
- Snapshot에는 대상 PR/head, 집계 범위와 시각, 본 에이전트와 서브 에이전트별 사용량, 실제 모델과 reasoning effort를 기록한다. 같은 agent의 모델 설정 변경도 보존한다.
- Snapshot 이후의 마무리 응답과 보고 자체 사용량은 제외될 수 있으며, 보고서에서 집계 시점을 명시한다.
- Model과 effort는 실행 사실과 [`agent-workflow.md`의 Code Worker runtime mapping](agent-workflow.md#code-worker-runtime-mapping) 준수 여부를 확인하기 위한 metadata다. Execution Issue의 worker tier를 특정 provider/model로 반복해 고정하는 근거로 사용하지 않는다.

### 집계와 정보 경계

- 집계와 보고서 생성은 dependency 없는 Node.js ESM command로 수행한다. 매번 AI가 raw 로그를 읽거나 임시 script를 작성해 수동 합산하지 않는다.
- 입력, 캐시 입력, 출력, 전체 토큰과 캐시 입력 제외 수치를 구분한다. 출력에 포함된 reasoning 토큰을 다시 더하지 않는다.
- Response별 usage record를 dedup하며 turn/thread 누적 counter를 반복 합산하지 않는다. 대상 root turn과 연결된 descendant만 재귀적으로 포함한다.
- 누적 `input_tokens`는 response별 처리량이며 메인 context의 현재 크기나 event wait 시간의 과금으로 해석하지 않는다. 대기 시간이나 대화 길이로 사용량을 추정하지 않는다.
- 사용량·모델·descendant 기록 누락, 잘린 로그 또는 검증할 수 없는 범위는 incomplete/unknown으로 표시한다. 누락을 0으로 채우거나 완전한 집계로 보고하지 않는다.
- Raw 대화, reasoning, tool input/output, credential, 개인 filesystem 경로와 내부 task/turn ID는 local에만 둔다. GitHub에는 보고에 필요한 aggregate field만 allowlist로 내보낸다.
- 구체적인 command와 file 위치는 [`../../scripts/README.md`](../../scripts/README.md)와 [`../reference/repository-map.md`](../reference/repository-map.md)에서 관리한다.

### Merge 후 게시

- GitHub workflow는 merged 상태와 linked Issue metadata를 확인하고, 검증된 snapshot으로 보고서를 생성한다. 단순 close, fork PR, 다른 repository Issue에는 게시하지 않는다.
- Snapshot의 작성자, schema, 대상 PR과 head를 검증한다. Snapshot 누락·오래된 head·불완전 집계는 보고 불가 또는 불완전 사유를 명시하며 수치를 추정하지 않는다.
- 보고 comment는 PR별 식별자를 사용하며 재실행 시 기존 자동 보고를 갱신한다. 다른 작성자의 comment를 덮어쓰지 않는다.
- Workflow는 trusted default branch code와 필요한 최소 GitHub permission만 사용한다. Local 로그 접근을 위해 새 Secret, 외부 서버 또는 상시 polling process를 추가하지 않는다.
- 보고 실패는 retry 가능한 실행 결과로 남기며 merge를 되돌리거나 AI가 추가 merge를 수행하지 않는다.

## 기존 Issue에 도입

승인 후 기존 Open Issue에 도입할 때는 body·preflight·PR과 실제 담당을 확인해 현재 roster와 상태를 맞춘다. 확인하지 못한 작업을 미배정으로 간주하거나 Rule 승인·실행 허용을 새로 만들지 않는다. 기존 `Ready`·`Blocked` label은 근거를 body에 옮기고 재조회한 뒤 제거한다.

## Automation boundary

Dispatch eligibility, dependency scheduling, retry bookkeeping, label transition, stale-head cancellation, deduplication은 입력 contract가 안정된 뒤 deterministic automation으로 옮길 수 있다. v0에서는 existing GitHub workflow와 수동 Issue/PR lifecycle을 사용하며 runtime, dispatcher, queue, model API, automatic merge를 추가하지 않는다.

PR 사용량 수집과 merge 후 보고 게시에는 위 contract에 한해 local command와 GitHub workflow를 사용한다. 이를 agent 실행 scheduler나 model API runtime으로 확장하지 않는다.
