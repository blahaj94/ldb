---
type: rule
status: active
enforcement: blocking
scope: repository
last-reviewed: 2026-09-08
---

# Testing

신규 test 판단과 아래 Red-Green·evidence·기대값 수정의 명확화는 [Issue #166](https://github.com/blahaj94/ldb/issues/166)의 제안이다. Draft PR의 명시적인 `승인` 전에는 기존 승인된 Rule을 적용하며, 이 변경안을 실행 근거로 사용하지 않는다.

```yaml
status: proposed
enforcement: blocking
rationale: 필수 검증을 유지하면서 신규 테스트의 필요성을 먼저 판단한다.
evidence: "Issue #166; PR #159, #142, #138, #140 및 신규 테스트 없는 PR #143"
exceptions: 동작 보존 검증과 test 변경 없는 Red는 아래의 구분을 따른다.
review-after: 적용 후 서로 다른 변경 유형의 PR 3건에서 판단 근거와 검증 누락 여부를 확인한다.
```

## 신규 test 판단

중요한 동작에는 검증 evidence가 필요하지만 production code 변경 자체가 신규 test의 근거는 아니다. 기존 test 축소·삭제를 목표로 하지 않는다.

구현 전에 Issue의 변경 범위와 관련 기존 test의 입력·assertion·실행 경로를 확인하고 필요한 최소 검증 사례를 정한다. 신규 사례마다 다음을 설명할 수 있어야 한다.

- 무엇이 잘못될 수 있고 그 결과가 왜 중요한가?
- 기존 test의 어떤 검증이 부족한가?
- 이 사례가 그 부족분을 실제로 검출하는가?
- 선택한 test 계층이 그 위험을 검증하기에 적절한가?

근거는 실제 bug뿐 아니라 요구사항, 중요한 내부·외부 계약과 합리적으로 예상되는 실패를 포함한다. 특히 권한·보안·데이터 무결성·파괴적 작업·동시성 등의 중요한 보호 공백을 우선한다. 판단이 불명확하면 관련 context를 더 확인하며 이해 부족을 검증 생략의 근거로 삼지 않는다.

구현 복제, 의미 없는 입력 변형, 독립적인 검증 가치가 없는 중복과 언어·type system·framework 보장의 반복은 추가하지 않는다. 내부 호출·순서·횟수는 그 자체가 중요한 계약일 때 검증하며, 중요한 경계값·외부 호출 제한·멱등성은 배제하지 않는다.

파일 수, test()/it() 개수나 coverage 수치를 목표로 삼지 않는다. 기존 파일의 사례 추가와 매개변수화에도 같은 판단을 적용하며, 여러 사례를 하나로 합쳐 개수만 줄이지 않는다. 작업 결과에는 신규 사례 수(0 포함), 각 사례가 보호하는 회귀 위험과 기존 검증의 부족분 또는 추가 없이 필수 검증을 충족한 근거를 짧게 남긴다.

## Red-Green workflow

핵심 logic과 behavior에는 아래 Required evidence의 검증이 필요하다. 새 동작·요구사항 변경과 bug fix에는 다음 순서를 적용한다.

1. GitHub Issue의 acceptance criteria에서 검증할 동작과 중요한 계약을 추출한다.
2. 관련 기존 test를 확인하고 부족한 사례만 구현 전에 추가·수정한다. Bug fix는 해당 bug를 직접 재현하는 최소 검증을 우선한다.
3. 요구사항 미구현 또는 해당 bug 때문에 실패하는 것을 확인하고, test 변경이 있으면 `test:` Red commit을 만든다.
4. 필요한 최소 implementation을 작성해 Green으로 만든다.
5. 관련 validation 전체를 실행한다.

기존 test가 이미 해당 bug를 재현하면 중복 사례를 추가하지 않는다. Test 변경이 없는 Red는 command·대상 revision·예상 실패 이유·실제 결과를 Issue/PR에 기록하며 빈 commit을 만들지 않는다. 기존 test의 통과만으로 새 요구사항의 Red를 대신하지 않는다.

동작 보존 refactor는 기존 test로 관련 계약을 변경 전후에 확인할 수 있으면 신규 test 없이 진행한다. 중요한 보호 공백은 refactor 전에 기존 동작을 확인하는 test로 보완한다. 이때 통과하는 test는 Red가 아니며, Red를 만들려고 production code를 일부러 망가뜨리지 않는다.

Rule 변경이 필요한 작업은 승인된 Rule commit 이후 Red-Green 순서를 시작한다. Red commit은 PR branch에서 허용되지만 최종 PR head는 반드시 Green이어야 한다. Main에는 squash merge하므로 의도적으로 실패하는 중간 commit이 남지 않는다.

Red-Green 대상의 병렬 작업도 이 선후 관계를 바꾸지 않는다. 같은 behavior의 Red 검증과 Green implementation을 서로 다른 Worker가 동시에 시작하지 않는다. Test 변경이 있으면 Issue 통합 branch에 먼저 반영하고, 기존 test 재사용도 통합 담당이 integration head에서 기대한 실패를 확인한 뒤 Green을 시작한다. 서로 다른 base에서 작성한 Red와 Green은 최신 integration head에서 실패 원인과 최종 통과를 다시 검증한다.

Test framework 또는 dependency가 없으면 임의로 추가하지 않는다. 새 dependency 승인을 먼저 요청한다.

## Required evidence

| 변경 종류                              | Required evidence                    |
| -------------------------------------- | ------------------------------------ |
| domain 또는 service logic              | unit test                            |
| API contract 또는 integration boundary | integration test                     |
| bug fix                                | 재현 가능한 regression test          |
| React state, hook, interaction logic   | component 또는 hook test             |
| Markup 또는 style-only                 | lint, build, visual 확인             |
| Generated file, mock, fixture          | consumer test 또는 생성·검증 command |

표는 필수 검증 종류와 범위이며 매번 신규 test 작성을 뜻하지 않는다. 기존 test도 해당 종류와 실제 검증 범위를 충족하면 사용한다. Regression은 목적이며 unit 또는 integration test가 회귀 검증을 겸할 수 있다.

변경이 여러 종류에 해당하면 필요한 evidence를 조합한다. 하나의 test로 여러 항목을 충족하려면 각 항목의 검증 종류와 범위를 모두 만족해야 한다. 계층 수를 채우기 위해 같은 시나리오를 반복하지 않으며, 계층별 독립 계약과 실제 통합 실패의 검증을 중복으로 취급하지 않는다.

기존 test 선택과 과거 실행의 PASS evidence 재사용은 별개다. 후자는 아래 검증 evidence 재사용의 입력·revision·환경·범위 조건을 그대로 따른다.

## Test integrity

- Test를 통과시키기 위해 assertion을 약화하거나 원래 acceptance criteria를 바꾸지 않는다.
- 실제로 변경된 요구사항은 필요한 승인을 확인한 뒤 해당 test의 기대값에 반영한다. 신규 사례 수를 줄이려고 여전히 유효한 사례·assertion을 교체하거나 약화하지 않는다.
- 잘못 작성된 test를 수정할 때는 이유를 PR에 설명한다.
- `skip`, `only`, 임시 disable 상태를 최종 PR에 남기지 않는다.
- Mock이 실제 contract의 중요한 behavior를 숨기지 않도록 한다.
- 큰 fixture와 snapshot은 logic review에서 분리될 수 있도록 별도 file 또는 commit에 둔다.

## Validation

- 변경한 workspace의 test, typecheck, lint, build를 가능한 범위에서 모두 실행한다.
- Main rebase 또는 semantic conflict 해결 후 전체 validation을 다시 실행한다.
- 실행하지 못한 command와 이유를 PR에 명시한다.
- 검증 실패를 success로 보고하지 않는다.
- 현재 사용 가능한 command는 [`../reference/repository-map.md`](../reference/repository-map.md)를 확인한다.

## 검증 evidence 재사용

아래 기준은 [PR #106의 사용자 승인](https://github.com/blahaj94/ldb/pull/106#issuecomment-5561177716)을 반영한다. 실행 전담의 완료 evidence와 보고는 [`agent-runner.md`](agent-runner.md), 재검토 조건은 [`실행 효율 계약의 재검토`](agent-workflow.md#실행-효율-계약의-재검토)를 따른다.

PASS는 기록된 check의 입력과 범위에만 유효하다. Parent 또는 통합 담당이 재사용 여부를 책임지며 다음을 모두 확인한다.

1. 같은 command·options와 성공 기준이며, exit/result·대상 revision·실행 범위가 확인된다.
2. 관련 source·test·config·dependency·lockfile·generated input·runtime/tool version·환경·외부 state가 동일하거나 유효성이 유지된다는 근거가 있다. Revision이 같다는 사실만으로 미commit 변경이나 외부 state의 안정성을 추정하지 않는다.
3. 그 check가 요구된 gate를 실제 포함했고 실행 이후 관련 입력 변화가 없거나 무관함을 판단한 근거가 있다. 근거가 없으면 필요한 확인 또는 재검증으로 보완한다.

Aggregate가 성공했고 포함된 command와 범위를 확인할 수 있으면 같은 입력의 개별 command를 중복 실행하지 않는다. 예를 들어 [`Native validation`](../../scripts/README.md#native-validation)의 Desktop build에 포함된 typecheck는 별도 반복을 생략한다. Aggregate가 실패했다면 전체 FAIL을 유지하고, 개별 성공이 명확한 check만 그 범위의 evidence로 기록한다. 후속 check가 실제 실행됐다고 추정하지 않는다.

실패 후에는 판단 owner가 수정 원인·변경 입력과 영향을 받는 check를 정한다. 영향받은 check와 dependent check를 다시 실행하고, 독립된 기존 PASS는 위 근거가 있을 때 재사용한다. 원인을 확인하지 못한 실패를 선택적 재실행으로 숨기거나 acceptance criteria를 줄이지 않는다.

이 재사용은 이 문서의 Required evidence·Test integrity·Red-Green과 [`change-control.md`](change-control.md#branch-worktree-and-parallel-work)의 통합 의무를 완화하지 않는다. Main rebase 또는 semantic conflict 해결 후 전체 validation을 다시 실행하고, 최종 integration exact head에서 필요한 전체 validation을 확인한다. Worker의 PASS만으로 이 gate를 대체하지 않는다. 최종 head에서 이미 성공한 전체 validation에 포함된 개별 command의 중복 실행을 생략하는 것은 가능하다.
