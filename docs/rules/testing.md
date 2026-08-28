---
type: rule
status: active
enforcement: blocking
scope: repository
last-reviewed: 2026-08-28
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
