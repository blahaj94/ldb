---
type: rule
status: active
enforcement: approval-required
scope: repository
last-reviewed: 2026-09-08
rationale: 기존 convention을 동작 보존 방식으로 작은 단위에 적용하고 저비용 실행의 판단 경계를 고정한다.
evidence: "https://github.com/blahaj94/ldb/pull/150#issuecomment-5580132558"
exceptions: 승인 전 실행 권한을 만들지 않으며 승인된 기존 Rule과 진행 중 Issue의 소유권을 바꾸지 않는다.
review-after: 시범 PR 2~3개를 사용자 merge한 뒤 실제 사용량·재작업·검토 부담을 확인한다.
---

# Convention Migration

이 Rule은 기존 코드에 최신 [`convention.md`](../../convention.md)를 적용하는 후속 작업의 이행 기준이다. 문서 자체는 제품 code, test, script, 설정, dependency를 바꾸지 않는다. Rule 승인과 사용자 merge 전에는 제품 code 이행을 시작하지 않는다.

기계적 formatter·lint 적용과 사람의 의미 판단을 나누는 active 역할 원칙과 공통 설정 도입 계약은 [`convention-tooling.md`](convention-tooling.md)를 따른다. 역할 원칙은 PR #163, 공통 설정·dependency·CI의 도입 기준은 PR #165의 사용자 승인·merge를 반영한다. 실제 구현·검증 완료 여부는 Issue #164의 구현 결과에서 확인한다.

## 동작 보존 범위

표기와 구조를 읽기 쉽게 바꾸되 반환값, 오류와 예외의 종류·우선순위, 평가 순서, 단락 평가, getter와 시계 조회 시점, 외부 호출 횟수와 순서, 상태 변경·rollback·cleanup, Promise와 async 순서를 유지한다. 원래 조건이 반복·재시도·상태 변경 뒤 평가됐다면 결과를 미리 고정하지 않는다. 값을 한 번 더 읽거나 호출을 한 번 더 하는 정리도 동작 변경으로 본다.

다음은 별도 판단으로 분리한다.

- public API, 오류 응답·log·IPC, 인증·권한, database·migration, 외부 provider 계약을 바꾸는 변경
- 새 core logic, behavior, dependency, runtime 또는 보안 의미를 추가하는 변경
- 평가 시점·호출 횟수·상태 전이·비동기 순서를 확인할 근거가 부족한 변경

이런 변경은 임의로 진행하지 않고 해당 Rule과 change-control의 승인·testing 절차를 따른다. 기존 Rule과 현재 code가 충돌하면 어느 쪽도 추측으로 고치지 않고 판단을 남긴다.

[`convention-exceptions-proposal.md`](convention-exceptions-proposal.md)의 두 예외는 PR #161의 사용자 `승인`과 merge로 active가 되었으며, 해당 문서의 pure check·collection predicate 조건을 충족하는 범위에만 적용한다. 그 승인 전에는 이 엄격한 보존 기준을 완화하지 않는다.

## 작업 단위와 순서

한 모듈에서는 한 종류의 변경만 다룬다. 초기 제품 code 작업은 3~5개 파일, 약 200 변경줄을 목표 상한으로 삼는 soft 기준이다. test·mock·fixture·snapshot·생성물도 review 부담에 포함하며, `code-quality.md`의 약 300 logic 줄 기준과 별개로 보고한다. 기준을 넘으면 기계적으로 줄이지 말고 독립 PR로 나눌 이유와 되돌리기 단위를 기록한다.

구현 PR은 한 번에 하나씩 순서대로 진행한다. 사용자가 앞선 PR을 merge한 뒤 다음 PR을 시작한다. 각 PR은 독립적으로 검토·되돌릴 수 있어야 하며, 구현·검토·통합의 소유권과 현재 기준 revision을 Issue에 남긴다. 진행 중인 다른 Issue의 scope를 가져오지 않는다.

작업 packet에는 대상 모듈, 변경 종류, 제외 범위, 기준 revision, 동작 보존 근거와 검증 command를 함께 둔다. 한 구현 PR이 끝나기 전에는 다음 구현을 병렬로 시작하지 않는다. 검토에서 의미 충돌이나 누락이 발견되면 해당 범위를 멈추고 같은 scope의 후속 판단을 기록한다.

## 병렬 실행

Issue #178과 PR #181에서 승인·merge된 좁은 병렬 실행 기준이다. 사용자 `승인` comment는 [PR #181](https://github.com/blahaj94/ldb/pull/181#issuecomment-5588297098)에 기록되어 있으며, 이 subsection은 해당 승인과 merge를 반영해 active로 적용한다.

```yaml
status: active
enforcement: approval-required
rationale: 서로 독립적인 convention migration PR의 대기 시간을 줄이되 충돌·오래된 기준·검토 누락을 제한한다.
evidence: "https://github.com/blahaj94/ldb/pull/181#issuecomment-5588297098"
exceptions: 의존성·evidence가 불명확하거나 scope가 겹치면 해당 작업은 순차로 진행하며 기존 active Rule을 적용한다.
review-after: 동시에 진행한 첫 3개 PR이 사용자 merge된 뒤 실제 충돌·재작업·검토 부담과 동시 한도를 재검토한다.
```

이 subsection은 위 `작업 단위와 순서`의 다음 세 문장의 적용 범위만 대체한다. “구현 PR은 한 번에 하나씩 순서대로 진행한다”, “사용자가 앞선 PR을 merge한 뒤 다음 PR을 시작한다”, “한 구현 PR이 끝나기 전에는 다음 구현을 병렬로 시작하지 않는다”가 그 대상이다. 작업 단위·독립 검토·소유권·기준 revision·의존성 판단·검증·사용자 merge를 포함한 나머지 Rule은 바꾸지 않는다.

동시에 열어 둘 구현 PR은 최대 3개로 한다. 각 PR은 별도 Issue, integration branch, 전용 worktree, 단일 owner를 갖고 같은 고정 base에서 시작한다. PR 간 변경 file과 public type·API·generated fixture·producer/consumer·shared mutable runtime·test를 서로 충돌하게 변경하지 않도록 packet에 기록한다. 같은 것을 읽거나 같은 검증 command를 사용하는 것만으로 독립성을 부정하지 않는다. 기존 `agent-execution.md`의 의미대로 같은 file·public contract·generated source·artifact·test fixture·snapshot·shared state를 상충하게 변경하거나 검증 환경을 격리할 수 없는 경우 병렬로 dispatch하지 않는다. Issue별 실행·사용량 수집 범위도 서로 독립적으로 구분할 수 있어야 한다. 현재 수집 도구로 분리할 수 없으면 먼저 분리된 실행 단위를 준비하거나 병렬 착수를 보류한다. 보고 의무 완화, 추정 분배, 새 collector 구현은 이 제안의 범위가 아니다.

병렬 dispatch는 기존 [`agent-execution.md`](agent-execution.md)의 독립성·실행 slot·roster·handoff·소유권 계약을 따른다. 이 제안은 slot 증설, owner 간 checkout 공유, 통합 branch 직접 편집, 또는 오래된 result의 자동 채택을 허용하지 않는다. 결과가 반환된 뒤 integration head가 전진했으면 [`change-control.md`](change-control.md)의 rebase와 semantic 확인을 거치고 필요한 validation을 다시 실행한다.

각 PR은 한 module·한 종류의 변경·작은 diff 원칙, 독립적인 최종 head validation·review·usage 기록을 유지한다. 여러 PR을 동시에 ready 상태로 준비할 수 있지만, 하나가 main에 merge된 뒤 남은 PR은 최신 main으로 rebase하고 semantic check와 전체 required validation을 다시 통과해야 ready·merge 대상이 된다. 병렬 사전 검증이 이 최종 확인을 대신하거나 일괄 면제를 만들지 않는다.

main이 전진하면 아직 merge되지 않은 모든 관련 PR을 다시 대조한다.
재검증 결과가 없으면 해당 PR을 ready로 표시하지 않는다.

각 PR의 merge는 기존과 같이 사용자만 수행한다. AI는 merge하지 않으며 scheduler나 자동 merge를 추가하지 않는다. 동시에 진행한 첫 3개 PR이 merge된 뒤 기록된 결과로 효과와 동시 한도를 재검토하며, 자동 만료나 매 묶음 재승인 조건을 만들지 않는다. 그 전에는 범위를 넓히거나 다른 Rule을 중복 작성하지 않는다.

## 의존성과 자원 격리 기반 병렬 실행

Issue #226에서 고정된 동시 PR 수 대신 실제 의존성과 자원 격리로 병렬 실행 수를 정하도록 요청했다. 다음 기준은 [PR #240의 사용자 승인](https://github.com/blahaj94/ldb/pull/240#issuecomment-5605496073)을 반영한다. 이 변경이 사용자 merge되기 전에는 위 active 기준과 최대 3개 제한을 그대로 적용한다.

```yaml
status: active
enforcement: approval-required
rationale: 독립적인 작업을 고정된 숫자로 대기시키지 않으면서 실제 충돌, host 자원 포화, 검토 누락을 배정 전에 제한한다.
evidence: "https://github.com/blahaj94/ldb/pull/240#issuecomment-5605496073"
exceptions: 소유권이나 격리를 증명하지 못하거나 가용한 실행, 검토 자원이 부족하면 병렬로 배정하지 않고 해당 작업을 대기시킨다.
review-after: 새 기준으로 처음 배정한 기능 PR 묶음이 사용자 merge된 뒤 실제 충돌, 재작업, 자원 대기, 검토 부담을 확인한다.
```

이 변경이 사용자 merge되면 이 기준이 위 병렬 실행의 “동시에 열어 둘 구현 PR은 최대 3개로 한다”와 첫 3개 PR을 기준으로 한 재검토 문구를 대체한다. 아래 `작업 단위 재계획 제안`의 “동시 최대 3개” 참조도 이 기준으로 대체한다. 다른 proposed Rule의 승인 상태나 구현 착수 조건은 바꾸지 않는다.

Planner는 작업별 file과 계약 소유권, generated source, artifact, fixture, snapshot, process와 port, database, native 권한과 장치, 사용량 수집 범위를 배정 전에 표로 기록한다. 각 항목에는 owner, 격리 방법, 필요한 실행과 검토 slot, 해제 조건을 둔다. Host의 CPU, memory, I/O와 실제로 사용할 수 있는 slot, 독립 review 가능 여부를 확인한 작업만 배정한다. 표가 비어 있거나 소유권과 격리 근거가 없거나 자원 포화로 안정적인 검증을 기대할 수 없으면 해당 작업을 대기시킨다. 실제 배정 수와 판단 근거는 각 Execution Issue의 착수 기록에 남긴다.

같은 file이나 계약, generated output을 상충하게 변경하거나 producer와 consumer를 동시에 바꾸는 작업은 병렬로 배정하지 않는다. 같은 mutable database, fixture, snapshot, runtime state를 공유하는 작업도 같다. 같은 source를 읽기만 하거나 같은 검증 command를 격리된 checkout과 자원에서 실행하는 것은 그 사실만으로 의존 작업이 되지 않는다. 공용 계약이 고정됐고 각 owner가 서로 다른 내부 구현과 산출물을 변경한다면 한 기능이 다른 기능을 소비한다는 관계만으로 merge 선행 조건을 만들지 않는다.

단일 Planner, Issue별 단일 통합 owner, 별도 integration branch, Worker branch, worktree, 공개 roster, 작은 Worker 범위는 유지한다. 승인된 model mapping, 같은 접근의 retry, 독립 review, 오래된 result의 semantic 확인, 최종 exact head 검증과 사용량 기록도 유지한다. 하나의 PR이 main에 merge되면 아직 merge되지 않은 관련 PR은 최신 main으로 rebase하고 의미를 대조한 뒤 전체 required validation을 다시 통과해야 ready, merge 대상이 된다. merge는 사용자만 수행한다.

이 기준은 실행 slot이나 host 용량을 무제한으로 간주하지 않는다. 자동 scheduler, 새 사용량 collector, 추정 사용량 분배, checkout 공유, 검증 면제, 자동 merge를 추가하지 않는다. 제품 code, test, dependency, 관련 없는 Rule activation은 별도 승인과 실행 범위를 따른다.

## 작업 단위 재계획 제안

Issue #196에서 사용자가 남은 PR 수를 줄이도록 작업 단위 재계획을 요청했다. 다음은 승인 전 제안이며, 사용자의 명시적인 `승인` comment와 사용자 merge 완료 전에는 기존 active Rule을 그대로 적용한다.

```yaml
status: proposed
enforcement: approval-required
rationale: convention 항목을 인위적으로 한 종류씩 잘라 남은 PR을 늘리지 않고, 하나의 기능·모듈을 검토하고 되돌릴 수 있는 단위로 완료한다.
evidence: "Issue #196 사용자의 남은 PR 재계획 요청"
exceptions: 동작·API·보안·Rule·새 dependency의 미결정 사항은 기존 승인 경계에 따라 보류하며, PR 수를 줄이기 위해 자동 승인·항목 누락·거대 diff·테스트 생략을 허용하지 않는다.
review-after: 첫 2개 기능 PR이 사용자 merge된 뒤 실제 검토 부담·재작업·되돌리기 단위와 남은 항목의 판단 필요 여부를 확인한다.
```

승인 후 이 제안은 위 `작업 단위와 순서`의 다음 기존 문장에 우선 적용한다.

- “한 모듈에서는 한 종류의 변경만 다룬다.”는 하나의 기능·모듈에 남은 승인된 convention 항목(예: 명명, 문자열 결과, 내부 인자명)을 관련 test와 필요한 callsite까지 함께 완료하는 단위로 대체한다.
- “초기 제품 code 작업은 3~5개 파일, 약 200 변경줄을 목표 상한으로 삼는 soft 기준이다.”의 숫자는 PR 크기 목표나 분리 기준에서 제외하고 내부 Worker 작업 분해의 참고로만 사용한다. PR 크기는 완료 범위, 실측한 예상 diff, 검토 가능성, 되돌리기 단위로 판단하며, `code-quality.md`의 약 300 logic 줄/commit soft 기준은 유지한다.
- 병렬 실행 subsection의 “각 PR은 한 module·한 종류의 변경·작은 diff 원칙”은 같은 기능·모듈의 승인된 항목을 한 PR에서 함께 검토할 수 있도록 대체하되, 독립 검토·되돌리기·기준 revision·의존성·최종 head 검증 조건은 그대로 유지한다.

작업 packet은 대상 기능·모듈, 남은 승인 항목, 관련 test와 필요한 callsite, 제외 범위, 기준 revision, 동작 보존 근거, 예상 diff와 검증 command를 기록한다. 같은 PR 안에서는 단계별 commit과 명시적인 범위를 유지한다. 숫자 목표를 맞추려고 무관한 기능을 묶지 않으며, PR 수를 줄이기 위해 기존 항목을 생략하거나 test를 약화하지 않는다.

모듈의 모든 항목을 완료했는지, 또는 승인·판단이 필요한 항목을 남겼는지 검토해 같은 파일을 불필요하게 다시 방문하지 않는다. 범위가 크면 예상 diff 규모, 검토를 나눌 이유, 되돌리기 단위와 상호 의존성을 근거로 분리를 제안한다. 임의의 새 파일 수 hard cap은 두지 않는다. 작은 Worker scope와 약 300 logic 줄의 commit soft 기준, 동시 최대 3개, dependency·사용량·root 분리, 독립 review, 최종 head 전체 검증, 사용자 merge 권한은 유지한다.

이 제안은 구체 작업 목록이나 일시적인 backlog를 Rule에 저장하지 않는다. 해당 목록과 현재 roster·의존성·base는 부모 Issue #196에서 관리한다. 모델 mapping 변경이나 scheduler·자동 merge 권한도 만들지 않는다.

## 전수 목록과 완료 기준

전수 확인 목록과 파일별 backlog는 수정 전에 후속 Execution Issue에 반드시 만든다. Planner가 목록의 생성·갱신·완료 상태를 책임지고, 실제 조사는 Scout나 Worker에게 맡길 수 있다. 기준 repository revision에서 범위를 확정하고 각 대상에 대해 `변경 필요`, `이미 준수`, `적용 제외`, `판단 필요`를 구분한다. 이미 준수·적용 제외에는 Rule 적용 범위와 연결된 근거를 남기며, 범위를 줄이거나 새 예외를 자동으로 판정하지 않는다. 변경 필요에는 연결된 PR의 사용자 merge evidence를 남긴다. 최종 Reviewer와 Planner는 전체 목록, 기준 revision, 분류 근거, merge evidence, 판단 필요·미반영 존재를 확인한 뒤 기존 완료 절차에 따라 처리한다. 판단 필요나 미반영 항목이 남아 있으면 전수 이행은 완료되지 않는다. 최종 main에서 새 파일·삭제·규칙 변경 보정을 다시 대조한다. 전수 조사 완료와 실제 리팩토링 완료는 별도 상태로 관리한다. 생성물은 원본 source를 기준으로 처리하고 generated artifact만 따로 정리하지 않는다. 이미 준수한 code는 수정하지 않는다.

이행 시작 시 적용할 `convention.md`와 연결 Rule의 revision을 고정한다. 의미가 바뀌지 않는 표기 변경마다 새 test를 강제하지 않으며, 동작 보존 evidence가 부족한 부분만 기존 동작을 고정하는 test로 보강한다. 표기 refactor의 필수 workspace test·typecheck·lint·build, 기존 실패의 Draft 유지와 validation 범위는 [`testing.md`](testing.md)와 [`change-control.md`](change-control.md)를 따른다. 새 core logic이나 behavior는 `testing.md`의 Red-Green을 따른다. 억지로 Red를 만들거나 기대 결과의 의미를 바꾸지 않는다.

검증은 성공 여부만 적지 않고 대상 revision, command 범위와 필요한 입력이 같은지 확인한다. 기존 test·mock·fixture·snapshot이 동작을 고정하는 경우 그 의미를 약화하거나 skip하지 않는다. 변경 전후 결과가 다르면 표기 refactor로 간주하지 않고 원인과 판단을 분리한다.

생성물은 원본 source의 변경 결과로 확인한다. 자동 생성 단계가 있는 경우 기존 formatter·generator·자동수정 command를 우선 사용하고 결과를 수동으로 다시 설계하지 않는다. 생성 결과와 원본이 어긋나면 이행 완료로 표시하지 않는다.

## 모델·검토·재검토

모델·effort 확인, retry·escalation, 비용 tier와 review 경계는 [`agent-workflow.md`](agent-workflow.md)의 canonical mapping을 따른다. 이 Rule은 동작 보존 이행의 적용 범위와 결과 검토 기준만 정한다.

시범 PR 2~3개를 사용자 merge한 뒤 기존 usage snapshot과 기록된 재작업·검토 부담을 바탕으로 예외를 재검토한다. 정밀 계측을 위한 새 wrapper나 rerun은 만들지 않는다. 기존 formatter와 자동수정을 먼저 사용한다. 실제 전수 조사와 이행 실행은 별도 Issue에서 승인된 기준으로 진행한다.

사용량과 재작업 기록이 없거나 일부만 관측되면 절감 효과를 추정하지 않고 `unknown` 또는 `incomplete`로 남긴다. 시범 결과가 convention 의미의 불명확성, 검토 부담 증가, 반복 재작업을 보이면 예외를 확대하지 않고 문서와 배정 기준을 다시 판단한다.

## 승인 경계

이 문서는 `change-control.md`의 approval evidence와 `testing.md`의 변경별 validation을 따른다. 기존 `병렬 실행` subsection은 PR #181의 사용자 승인과 merge를 반영하며, `의존성과 자원 격리 기반 병렬 실행`은 PR #240의 사용자 승인을 반영한다. 새 기준의 적용은 해당 변경의 사용자 merge 후에 시작하며 Rule 승인과 사용자 merge 권한은 기존 change-control 경계를 유지한다.
