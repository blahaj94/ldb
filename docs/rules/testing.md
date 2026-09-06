---
type: rule
status: active
enforcement: blocking
scope: repository
last-reviewed: 2026-09-07
---

# Testing

## Red-Green workflow

핵심 logic과 behavior 변경은 test 없이 구현하지 않는다.

1. GitHub Issue의 acceptance criteria에서 observable behavior를 추출한다.
2. 구현 전에 해당 behavior를 검증하는 test를 작성한다.
3. 기대한 이유로 실패하는 것을 확인하고 `test:` Red commit을 만든다.
4. 필요한 최소 implementation을 작성해 Green으로 만든다.
5. 관련 validation 전체를 실행한다.

Rule 변경이 필요한 작업은 승인된 Rule commit 이후 Red-Green 순서를 시작한다. Red commit은 PR branch에서 허용되지만 최종 PR head는 반드시 Green이어야 한다. Main에는 squash merge하므로 의도적으로 실패하는 중간 commit이 남지 않는다.

병렬 작업도 이 선후 관계를 바꾸지 않는다. 같은 behavior의 Red test와 Green implementation을 서로 다른 Worker가 동시에 시작하지 않는다. Red가 기대한 이유로 실패하는 것을 확인하고 Issue 통합 branch에 반영한 뒤 Green을 시작한다. 서로 다른 base에서 작성한 Red와 Green은 최신 integration head에서 실패 원인과 최종 통과를 다시 검증한다.

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

변경이 여러 종류에 해당하면 필요한 evidence를 조합한다.

## Test integrity

- Test를 통과시키기 위해 assertion을 약화하거나 원래 acceptance criteria를 바꾸지 않는다.
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
