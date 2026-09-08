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

기계적 formatter·lint 적용과 사람의 의미 판단을 나누는 제안은 [`convention-tooling.md`](convention-tooling.md)를 따른다. 이 proposed Rule이 승인되기 전에는 기존 active Rule과 현재 설정을 우선하며, 승인 후에도 확인된 config·version·glob·ignore 범위만 사용한다.

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

이 문서는 `change-control.md`의 approval evidence와 `testing.md`의 변경별 validation을 따른다. 승인 전에는 제안 상태이며 실행 authority가 없다. Rule 승인과 사용자 merge 권한은 기존 change-control 경계를 유지한다.
