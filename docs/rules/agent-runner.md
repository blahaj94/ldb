---
type: rule
status: active
enforcement: approval-required
scope: repository
last-reviewed: 2026-09-07
rationale: 판단이 확정된 command의 실행·monitor·사실 보고를 하나의 owner에게 맡겨 중복 실행과 불완전한 성공 보고를 막는다.
evidence: "Issue #105, PR #106 사용자 승인: https://github.com/blahaj94/ldb/pull/106#issuecomment-5561177716"
exceptions: 입력·판정·권한이 불명확하면 Runner가 추측으로 넓히지 않고 판단 owner에게 반환한다.
review-after: agent-workflow.md의 실행 효율 계약의 재검토 조건을 따른다.
---

# Agent Runner

## 범위와 권한

[PR #106의 사용자 승인](https://github.com/blahaj94/ldb/pull/106#issuecomment-5561177716)과 merge를 반영한 active Rule이다. 역할 선택·model·adapter 경계와 재검토는 [`agent-workflow.md`](agent-workflow.md#실행-효율-계약의-재검토), 실행 보조 기록은 [`agent-execution.md`](agent-execution.md#실행-보조-기록), PASS 채택·재사용과 필수 gate는 [`testing.md`](testing.md#검증-evidence-재사용)를 따른다.

Runner는 구현 Worker와 별도의 검증 보조 역할이다. Parent 또는 판단 Worker가 확정한 command 실행·monitor·사실 보고만 맡고, 원인 조사·test 의미 해석·code 수정·새 command 탐색·설치·commit을 수행하지 않는다. 구현·조사·판정 설계는 parent의 허용된 직접 scope 또는 판단 Worker가 맡는다. 긴 command의 위임 여부는 [`수행 모드 선택`](agent-workflow.md#수행-모드-선택)의 비용 판단을 따른다.

## Parent가 확정할 실행 packet

| 필수 항목 | 전달할 내용 |
| --- | --- |
| 실행 계약 | 정확한 cwd, executable·args·options, command별 check ID, 선행 dependency, 기대 exit/result와 PASS·FAIL 기준 |
| 입력과 checkout | Checkout owner·branch·head, 허용된 미commit 변경 baseline, 관련 source/config/dependency·lockfile/runtime·환경 입력, 실행 전후 비교 command와 기대 기준 |
| 변경과 자원 | Command가 만드는 generated output·cache·port·DB 등 mutable resource와 허용 범위, 격리 또는 순차 실행 방법, 잔여 자원 확인·회수 owner |
| 완료와 monitor | 새 job은 local process/session handle 또는 remote job ID를 수집·보존할 방법을 전달하고 시작 결과에서 실제 handle/ID를 기록한다. 기존 job 인계에는 접근 가능한 실제 handle/ID와 마지막 확인 상태를 전달한다. 두 경우 모두 전체 job의 terminal state·exit evidence를 얻을 정확한 조회 방법을 포함한다. |
| 제한과 실패 | Job별 deadline, 실패 시 중단할 dependent check와 계속해도 안전한 independent check, 취소 owner·허용 command·확인 방법, 명시된 retry policy와 남은 budget |
| 반환 | 아래 고정 report, 필요한 evidence 위치, 누락·변경·실패를 돌려보낼 판단 owner |

개인 cwd·내부 session ID와 raw log는 local packet에만 두고 공개 기록에는 필요한 안전한 pointer·결론만 남긴다. Secret 값은 packet·보고에 복제하지 않는다.

검증 대상 checkout owner는 실행 전에 관련 입력을 고정하고 실행 중 수정을 막는다. Runner가 기존 Worker나 integration checkout을 검증하는 것은 그 owner가 정한 배타적 실행 구간에 한하며, 여러 editor가 checkout을 공유할 권한이 아니다. Generated output과 port도 충돌 가능성을 먼저 확인한다. 별도 검증 checkout이 필요하면 parent가 고정된 대상을 준비하고 동일 입력 여부를 책임진다.

Runner는 전달받은 baseline/check만 실행해 입력 안정성을 확인한다. 판정 기준이 없거나 비교 결과를 해석해야 하면 해당 check를 `BLOCKED`로 반환한다. 예상 밖 변경을 되돌리거나 범위를 넓혀 조사하지 않는다. Parent 또는 판단 Worker가 관련성을 판정하며, 무관한 file 변경만으로 모든 evidence를 폐기하지 않는다. 관련 입력이 실행 중 변한 check는 PASS로 채택하지 않는다.

## 실행·대기·취소·재시도

- 실행과 monitor는 하나의 job owner가 맡는다. 인계할 때 handle·job ID·상태·deadline·취소 책임을 함께 넘기고 새 owner의 수락을 확인한다. 기존 owner는 더 이상 중복 monitor하거나 재실행하지 않는다.
- 실행 중인 job은 같은 handle로 resume·wait한다. 응답이 늦거나 monitor가 끊겼다고 command를 새로 시작하지 않는다. Event 기반 wait를 우선하고 필요 polling은 packet의 간격·deadline을 따른다.
- Shell monitor command의 exit 0은 remote job 성공을 뜻하지 않는다. Remote job의 terminal conclusion과 대상 revision, local 전체 job의 exit code를 각각 확인한다. 로그 일부의 성공 문구나 마지막 하위 check만으로 전체 PASS를 선언하지 않는다.
- 선행 check가 실패하면 dependent check는 실행하지 않고 이유를 남긴다. Packet에서 안전하다고 정한 independent check는 계속한다. 의존성·자원 안전성이 미정이면 해당 check를 `BLOCKED`로 돌려보낸다.
- Deadline에 도달하면 `TIMEOUT`과 실제 실행·취소 상태를 구분해 보고한다. Packet이 허용한 정확한 자원만 취소하고 종료를 확인한다. 취소 권한·handle이 없거나 종료 확인이 안 되면 책임 owner에게 인계하며 `RUNNING`에 남긴다. Timeout·취소 요청만으로 종료를 가정하지 않는다.
- 수정된 원인과 새 입력 또는 미리 정한 bounded retry policy가 없으면 재실행하지 않는다. 허용된 job retry는 attempt·이유·남은 budget을 기록한다. 기존 Worker 최대 1회 retry·escalation을 유지하고, Runner 재배정으로 retry budget을 초기화하지 않는다. 원인 수정은 판단 owner의 scope다. Provider/network retry automation의 별도 승인 경계도 유지한다.
- 이미 있는 실행 시각·tool metadata는 활용할 수 있다. Optional timing을 위해 wrapper를 만들거나 command를 다시 실행하지 않는다.

## 고정 결과 형식

```text
STATUS: PASS | FAIL | BLOCKED | TIMEOUT
CHECKS: check별 상태; 미실행은 SKIPPED와 선행 실패·취소 등 사유
EVIDENCE: command/options, 대상 revision·입력 근거, whole-job exit/result, 필요한 안전한 pointer
EXCEPTIONS: baseline 불명·일부 실패·timeout·retry·미실행 gate와 판단 owner
CHANGES: 예상 generated output / 예상 밖 변경 / 없음
RUNNING: 남은 job·마지막 상태·인계/취소 owner / 없음
```

대표 `STATUS` 우선순위는 `FAIL > TIMEOUT > BLOCKED > PASS`다. 유효한 FAIL과 다른 check의 BLOCKED·TIMEOUT을 `CHECKS`·`EXCEPTIONS`에 모두 보존한다. 예상한 Red 실패는 check의 실제 exit와 기대 실패 이유를 기록하고 해당 단계의 계약 충족 여부를 별도로 표시한다. Aggregate의 non-zero exit를 PASS로 바꾸지 않는다. 필수 check가 미실행·판정 불가하거나 job이 남았으면 전체 PASS가 아니다. Deadline 전 미완료 job을 인계할 때는 `BLOCKED`, deadline 도달 시에는 `TIMEOUT`으로 기록한다. Report는 약 15줄을 soft default로 하되 필요한 evidence와 혼합 상태를 생략하지 않는다.
