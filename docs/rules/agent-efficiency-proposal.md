---
type: rule
status: proposed
enforcement: approval-required
scope: repository
last-reviewed: 2026-09-07
rationale: 작은 작업의 위임·인계·검토 비용과 command 실행·monitor·중복 검증 비용을 줄이면서 승인과 evidence 책임을 유지한다.
evidence: "Issue #105: https://github.com/blahaj94/ldb/issues/105"
exceptions: 직접 수행 조건이나 고정된 실행 입력이 충족되지 않으면 기존 역할 분리와 escalation을 유지한다.
review-after: 승인·canonical 반영 후 실제 Execution Issue 3개에서 직접 수행·실행 전담·PASS 재사용 사례와 누락을 검토한다. 사례가 없던 항목은 검증됐다고 간주하지 않는다.
---

# Agent 실행 효율과 역할 분리 제안

기존 active Rule이 우선한다. 이 문서는 [Issue #105](https://github.com/blahaj94/ldb/issues/105)의 승인 대상 proposal이며, [`Approval evidence`](change-control.md#approval-evidence)에 따른 Draft PR의 명시적 `승인`과 canonical 반영 전에는 실행 authority가 아니다. 이번 작업은 제안서와 index pointer만 작성하며 새 역할·직접 수행 예외·검증 재사용 정책을 시험 적용하지 않는다.

## 현재와 제안

| 항목 | 현재 active Rule | 승인 대상으로 제안하는 변경과 이유 |
| --- | --- | --- |
| Parent의 작은 작업 | Planner는 Worker를 겸하지 않고 상세 작업을 별도 context에 배정한다. | 아래 조건의 단독 수행에서는 parent가 Worker를 겸한다. 별도 context 시작·packet·인계·검토의 합계 비용을 함께 판단한다. |
| 실행과 monitor | Worker의 validation 책임과 일반 handoff·retry 규칙을 적용한다. | 판단을 마친 command는 실행 전담 보조 역할에 맡길 수 있다. 실행과 monitor의 owner를 하나로 유지한다. |
| 검증 재사용 | 관련 validation과 최종 head 검증을 요구하며, Native validation은 포함된 command의 중복 실행을 줄인다. | PASS의 입력·범위·종료 evidence를 명시해 재사용한다. 필수 gate는 그대로 유지한다. |
| 역할과 model | 승인된 capability tier와 Code Worker runtime mapping을 적용한다. | 역할 routing만 제안한다. Astra Medium 기본값과 기존 승인 mapping은 유지한다. |

긴 command라는 이유만으로 위임하지 않는다. Parent가 다른 독립 판단을 계속할 수 있는지, packet 작성·실행 시작·대기·인계·review·오류 복구까지의 비용이 줄어드는지 비교한다. 시간이나 변경 줄 수만으로 수행 모드를 고르지 않는다.

## 수행 모드와 소유권

여기서 parent는 현재 Issue의 Planner를 뜻한다. 직접 수행은 다음 조건을 모두 만족할 때만 선택한다.

- Scope와 AC가 승인된 결정·기존 Rule 안에서 확정됐고 필요한 실행 허용과 preflight가 있다.
- 기존 pattern으로 처리할 수 있으며 uncertainty와 risk가 모두 `low`다. 단순해 보여도 새 의미·설계 판단이 필요하면 이 조건을 충족하지 않는다.
- 관련 context가 bounded하고 별도 Worker context 유지의 이점보다 위임·인계·검토 비용이 크다고 짧게 설명할 수 있다.
- 다른 미완료 Worker 산출물과 결합하지 않고 file·public contract·generated output·port·DB 등 shared state와 충돌하지 않는다.
- High-risk, architecture, security, Rule 변경의 즉석 직접 구현 예외로 사용하지 않는다. 승인·dependency 선택·Red-Green·review 경계는 그대로다.

| 모드 | Issue roster와 `worker_count` | Branch·worktree와 통합 책임 |
| --- | --- | --- |
| 단독 직접 수행 | Parent가 맡은 bounded Worker scope를 공개 식별자와 함께 roster에 기록한다. `worker_count: 1`이며 Planner·Worker·통합 담당을 겸한다는 사실과 선택 근거를 명시한다. | 유일한 editor인 parent가 Issue 통합 branch·전용 worktree에서 구현과 통합을 맡는 제한적 예외다. 별도 Worker branch를 중복 생성하지 않으며 main 직접 작업은 금지한다. |
| 위임 수행 | 기존 Worker roster·count·상태·배정 절차를 유지한다. Parent는 Planner·통합 역할만 맡는다. | 각 editor는 기록된 integration head에서 별도 branch·worktree를 사용한다. 통합 checkout의 owner는 한 명이며 parent가 맡긴 scope를 직접 보정하지 않는다. |

단독 parent도 Issue·승인·preflight·scope·base·상태·result commit·검증·완료 기록을 생략하지 않는다. 자신의 result를 통합한 경우도 exact result와 최종 head evidence를 구분하고 필요한 독립 review와 사용자 merge를 유지한다.

모드를 바꾸기 전에 진행 작업을 멈추고 결과·미완료 변경·검증·shared resource를 인계한다. Planner가 roster·count·base·branch·owner와 변경 이유를 갱신·재조회한 뒤 새 모드를 시작한다. 다른 Worker가 남아 있는 동안 parent를 추가 editor로 끼워 넣지 않는다. 복수 editor가 필요하면 위임 모드와 별도 branch·worktree를 사용한다. 재배정은 기존 중단 확인·공개 식별자·retry 이력을 보존한다.

이미 배정한 scope의 수정·추가 검증은 유효한 기존 Worker에게 변경분만 전달한다. Parent가 기다리는 동안 같은 탐색·구현·검증을 반복하지 않는다. 통합 담당의 scope·diff·evidence review와 아래 필수 gate 검증은 유지하며, evidence 결손이나 관련 입력 변화가 있을 때만 추가 검증의 이유를 남긴다.

## 실행 전담 보조 역할

Runner는 구현 Worker와 별도의 검증 보조 역할이다. Parent 또는 판단 Worker가 확정한 command 실행·monitor·사실 보고만 맡고, 원인 조사·test 의미 해석·code 수정·새 command 탐색·설치·commit을 수행하지 않는다. 구현·조사·판정 설계는 parent의 허용된 직접 scope 또는 판단 Worker가 맡는다.

Runner는 Worker scope를 대체하지 않으며 `worker_count`에 더하지 않는다. Issue에는 별도 실행 보조 기록으로 공개 식별자, 요청 owner, 대상 checkout owner·head, check/job 식별자, 상태와 evidence를 남긴다. Result commit이 없으면 `없음 — 실행 전담`으로 기록한다. 실행만 남은 Issue도 결과와 AC를 책임지는 parent의 단독 Worker slot 또는 판단 Worker slot을 유지하므로 count를 0으로 만들지 않는다. 실제 실행 slot과 사용량에는 Runner를 포함한다.

### Parent가 확정할 실행 packet

| 필수 항목 | 전달할 내용 |
| --- | --- |
| 실행 계약 | 정확한 cwd, executable·args·options, command별 check ID, 선행 dependency, 기대 exit/result와 PASS·FAIL 기준 |
| 입력과 checkout | Checkout owner·branch·head, 허용된 미commit 변경 baseline, 관련 source/config/dependency·lockfile/runtime·환경 입력, 실행 전후 비교 command와 기대 기준 |
| 변경과 자원 | Command가 만드는 generated output·cache·port·DB 등 mutable resource와 허용 범위, 격리 또는 순차 실행 방법, 잔여 자원 확인·회수 owner |
| 완료와 monitor | Local process/session handle 또는 remote job ID, 전체 job의 terminal state·exit evidence를 얻을 정확한 조회 방법, 인계 시 마지막 확인 상태 |
| 제한과 실패 | Job별 deadline, 실패 시 중단할 dependent check와 계속해도 안전한 independent check, 취소 owner·허용 command·확인 방법, 명시된 retry policy와 남은 budget |
| 반환 | 아래 고정 report, 필요한 evidence 위치, 누락·변경·실패를 돌려보낼 판단 owner |

개인 cwd·내부 session ID와 raw log는 local packet에만 두고 공개 기록에는 필요한 안전한 pointer·결론만 남긴다. Secret 값은 packet·보고에 복제하지 않는다.

검증 대상 checkout owner는 실행 전에 관련 입력을 고정하고 실행 중 수정을 막는다. Runner가 기존 Worker나 integration checkout을 검증하는 것은 그 owner가 정한 배타적 실행 구간에 한하며, 여러 editor가 checkout을 공유할 권한이 아니다. Generated output과 port도 충돌 가능성을 먼저 확인한다. 별도 검증 checkout이 필요하면 parent가 고정된 대상을 준비하고 동일 입력 여부를 책임진다.

Runner는 전달받은 baseline/check만 실행해 입력 안정성을 확인한다. 판정 기준이 없거나 비교 결과를 해석해야 하면 해당 check를 `BLOCKED`로 반환한다. 예상 밖 변경을 되돌리거나 범위를 넓혀 조사하지 않는다. Parent 또는 판단 Worker가 관련성을 판정하며, 무관한 file 변경만으로 모든 evidence를 폐기하지 않는다. 관련 입력이 실행 중 변한 check는 PASS로 채택하지 않는다.

### 실행·대기·취소·재시도

- 실행과 monitor는 하나의 job owner가 맡는다. 인계할 때 handle·job ID·상태·deadline·취소 책임을 함께 넘기고 새 owner의 수락을 확인한다. 기존 owner는 더 이상 중복 monitor하거나 재실행하지 않는다.
- 실행 중인 job은 같은 handle로 resume·wait한다. 응답이 늦거나 monitor가 끊겼다고 command를 새로 시작하지 않는다. Event 기반 wait를 우선하고 필요 polling은 packet의 간격·deadline을 따른다.
- Shell monitor command의 exit 0은 remote job 성공을 뜻하지 않는다. Remote job의 terminal conclusion과 대상 revision, local 전체 job의 exit code를 각각 확인한다. 로그 일부의 성공 문구나 마지막 하위 check만으로 전체 PASS를 선언하지 않는다.
- 선행 check가 실패하면 dependent check는 실행하지 않고 이유를 남긴다. Packet에서 안전하다고 정한 independent check는 계속한다. 의존성·자원 안전성이 미정이면 해당 check를 `BLOCKED`로 돌려보낸다.
- Deadline에 도달하면 `TIMEOUT`과 실제 실행·취소 상태를 구분해 보고한다. Packet이 허용한 정확한 자원만 취소하고 종료를 확인한다. 취소 권한·handle이 없거나 종료 확인이 안 되면 책임 owner에게 인계하며 `RUNNING`에 남긴다. Timeout·취소 요청만으로 종료를 가정하지 않는다.
- 수정된 원인과 새 입력 또는 미리 정한 bounded retry policy가 없으면 재실행하지 않는다. 허용된 job retry는 attempt·이유·남은 budget을 기록한다. 기존 Worker 최대 1회 retry·escalation을 유지하고, Runner 재배정으로 retry budget을 초기화하지 않는다. 원인 수정은 판단 owner의 scope다. Provider/network retry automation의 별도 승인 경계도 유지한다.
- 이미 있는 실행 시각·tool metadata는 활용할 수 있다. Optional timing을 위해 wrapper를 만들거나 command를 다시 실행하지 않는다.

### 고정 결과 형식

```text
STATUS: PASS | FAIL | BLOCKED | TIMEOUT
CHECKS: check별 상태; 미실행은 SKIPPED와 선행 실패·취소 등 사유
EVIDENCE: command/options, 대상 revision·입력 근거, whole-job exit/result, 필요한 안전한 pointer
EXCEPTIONS: baseline 불명·일부 실패·timeout·retry·미실행 gate와 판단 owner
CHANGES: 예상 generated output / 예상 밖 변경 / 없음
RUNNING: 남은 job·마지막 상태·인계/취소 owner / 없음
```

대표 `STATUS` 우선순위는 `FAIL > TIMEOUT > BLOCKED > PASS`다. 유효한 FAIL과 다른 check의 BLOCKED·TIMEOUT을 `CHECKS`·`EXCEPTIONS`에 모두 보존한다. 예상한 Red 실패는 check의 실제 exit와 기대 실패 이유를 기록하고 해당 단계의 계약 충족 여부를 별도로 표시한다. Aggregate의 non-zero exit를 PASS로 바꾸지 않는다. 필수 check가 미실행·판정 불가하거나 job이 남았으면 전체 PASS가 아니다. Deadline 전 미완료 job을 인계할 때는 `BLOCKED`, deadline 도달 시에는 `TIMEOUT`으로 기록한다. Report는 약 15줄을 soft default로 하되 필요한 evidence와 혼합 상태를 생략하지 않는다.

## 검증 evidence 재사용

PASS는 기록된 check의 입력과 범위에만 유효하다. Parent 또는 통합 담당이 재사용 여부를 책임지며 다음을 모두 확인한다.

1. 같은 command·options와 성공 기준이며, exit/result·대상 revision·실행 범위가 확인된다.
2. 관련 source·test·config·dependency·lockfile·generated input·runtime/tool version·환경·외부 state가 동일하거나 유효성이 유지된다는 근거가 있다. Revision이 같다는 사실만으로 미commit 변경이나 외부 state의 안정성을 추정하지 않는다.
3. 그 check가 요구된 gate를 실제 포함했고 실행 이후 관련 입력 변화가 없거나 무관함을 판단한 근거가 있다. 근거가 없으면 필요한 확인 또는 재검증으로 보완한다.

Aggregate가 성공했고 포함된 command와 범위를 확인할 수 있으면 같은 입력의 개별 command를 중복 실행하지 않는다. 예를 들어 [`Native validation`](../../scripts/README.md#native-validation)의 Desktop build에 포함된 typecheck는 별도 반복을 생략한다. Aggregate가 실패했다면 전체 FAIL을 유지하고, 개별 성공이 명확한 check만 그 범위의 evidence로 기록한다. 후속 check가 실제 실행됐다고 추정하지 않는다.

실패 후에는 판단 owner가 수정 원인·변경 입력과 영향을 받는 check를 정한다. 영향받은 check와 dependent check를 다시 실행하고, 독립된 기존 PASS는 위 근거가 있을 때 재사용한다. 원인을 확인하지 못한 실패를 선택적 재실행으로 숨기거나 acceptance criteria를 줄이지 않는다.

이 재사용은 [`testing.md`](testing.md)의 Required evidence·Test integrity·Red-Green과 [`change-control.md`](change-control.md#branch-worktree-and-parallel-work)의 통합 의무를 완화하지 않는다. Main rebase 또는 semantic conflict 해결 후 전체 validation을 다시 실행하고, 최종 integration exact head에서 필요한 전체 validation을 확인한다. Worker의 PASS만으로 이 gate를 대체하지 않는다. 최종 head에서 이미 성공한 전체 validation에 포함된 개별 command의 중복 실행을 생략하는 것은 가능하다.

## Model·Rule·adapter의 경계

- 공통 routing 판단·소유권·evidence 계약은 canonical Rule에서 관리한다. 향후 skill은 역할 선택과 필요한 Rule pointer만, custom-agent TOML은 model·effort·역할 제한 등 실행 설정만 담는 얇은 adapter로 둔다. 원문 지침을 여러 파일에 복제하지 않는다.
- Code Worker는 [`Code Worker runtime mapping`](agent-workflow.md#code-worker-runtime-mapping)의 Astra Medium 기본값과 승인된 예외를 유지한다. 직접 수행하는 parent도 code 역할의 mapping을 우회하지 않는다. Tier와 실제 model·effort를 구분하고 실제 적용을 확인한다.
- Luna execution-only 구상은 역할 분리 아이디어로만 채택한다. Luna Xhigh나 Astra Low를 새로운 mapping으로 확정하지 않는다. Model 변경 실험은 별도 bounded 제안·승인·실제 실행 evidence가 필요하다.
- Runtime이 요구한 custom role·model·effort를 지원하지 않거나 확인할 수 없으면 적용했다고 주장하거나 조용히 다른 model로 바꾸지 않는다. 가용성 문제를 알리고 기존 승인 설정의 허용된 owner가 실행하거나 새 선택을 요청한다.
- 이번 diff에는 실제 `SKILL.md`, custom-agent TOML, config·dependency 설치를 포함하지 않는다. 승인은 adapter 설치나 제품 구현 착수와 구분하고 후속 Issue에서 범위·실행 조건을 확인한다.

## 대안과 재검토

| 대안 | 선택 또는 보류 이유 |
| --- | --- |
| 모든 작업을 계속 Worker에게 위임 | 소유권이 단순하다. 작은 작업의 초기 context·handoff 비용이 커질 수 있어 조건부 단독 수행과 비교한다. 조건 미충족 시 유지하는 방식이다. |
| 짧은 작업은 parent가 무조건 처리 | 시간·줄 수로 uncertainty와 결합을 놓치므로 보류한다. 직접 수행 조건과 mode 전환 기록을 우선한다. |
| 모든 긴 command를 Runner에 배정 | 다른 독립 작업이 없으면 시작·인계 비용만 늘어 보류한다. 실행과 monitor의 단일 owner 원칙은 위임하지 않아도 적용한다. |
| Luna Xhigh Runner·Astra Low Worker를 즉시 기본값으로 사용 | 실행 안정성·판정 품질·총비용 evidence가 없어 보류한다. 역할 계약과 model 실험을 분리한다. |
| 모든 PASS를 매번 재실행하거나 무조건 캐시 | 전자는 비용, 후자는 stale evidence 문제가 있어 관련 입력과 필수 gate로 판단한다. |

승인·canonical 반영 후 실제 Execution Issue 3개에서 수행 모드 선택 이유, 위임·인계·review 추가 작업, 중복 command 생략, 재실행 이유, evidence 누락과 총사용량 snapshot을 검토한다. 기존 시각·사용량 기록만 활용하며 정밀 timing을 위한 새 wrapper·rerun은 하지 않는다. 누락·소유권 충돌·잘못된 PASS 채택이 있으면 해당 예외의 확대를 멈추고 수정 또는 폐기를 제안한다. 관측하지 못한 사례나 절감량은 추정하지 않는다.

## 현실적인 handoff 확인 사례

| 상황 | 제안에 따른 결과 |
| --- | --- |
| 승인된 AC·기존 pattern의 작은 수정이고 다른 작업과 독립 | Parent 직접 mode와 Worker slot 1개를 기록하고 Issue worktree에서 Red-Green·최종 검증·review를 수행한다. 새 설계가 드러나면 중단·재배정한다. |
| 구현 Worker가 고정한 checkout에서 Runner가 build 실행 | Checkout owner가 입력 변경을 멈추고 output·port 충돌을 제거한다. Runner는 같은 handle을 기다려 전체 exit와 전후 baseline을 반환한다. |
| Aggregate의 lint는 PASS, test는 FAIL, 뒤 build는 미실행 | 전체 FAIL, lint evidence와 build 미실행 사유를 모두 보고한다. 수정 후 test·필요한 dependent check를 실행하며 aggregate PASS로 위장하지 않는다. |
| Remote monitor는 exit 0이나 job은 진행 중이고 deadline 도달 | TIMEOUT과 RUNNING을 함께 기록하고 job ID·취소 책임을 넘긴다. 새 job을 시작하거나 성공으로 보고하지 않는다. |
| PASS 뒤 무관한 문서만 변경 / main rebase 발생 | 전자는 관련 입력 불변의 근거로 재사용을 판단한다. 후자는 전체 validation을 다시 실행한다. |

## 승인 후 canonical 반영 위치

| Canonical path·절 | 반영할 결정 |
| --- | --- |
| [`agent-workflow.md`](agent-workflow.md)의 역할과 단일 책임·Execution Issue·Planning과 model tier | 조건부 parent 겸임, Worker count와 실행 보조의 구분. 기존 Code Worker mapping 유지 |
| [`agent-execution.md`](agent-execution.md)의 범위와 권한·Worker roster와 상태·Handoff와 context·Branch와 통합·진행, 대기와 완료·중단·재배정과 retry | 수행 모드·실행 보조 기록·packet·job owner·결과 형식·mode 전환과 retry 경계 |
| [`change-control.md`](change-control.md)의 Branch, worktree, and parallel work | 단독 parent의 통합 checkout 구현 예외, Runner의 배타적 검증 접근, 복수 editor 격리와 최종 gate 유지 |
| [`testing.md`](testing.md)의 Validation | 입력 근거가 있는 PASS 재사용·aggregate 중복 생략·실패 영향 범위 재검증과 필수 gate 유지 |
| [`docs/README.md`](../README.md)의 역할별 시작점·Index | 승인된 직접 수행·Runner route의 canonical pointer |

승인된 범위를 위 canonical 절에 반영할 때 겹치는 계약과 proposal 상태를 함께 정리한다. 이 문서를 별도의 두 번째 active 계약으로 남기지 않는다. 공통 운영 Rule은 해당 canonical file에 모으고 이 문서는 승인·결정 pointer를 보존하는 이력으로 전환한다.
