## Related Issue

- Closes #

## Preflight

- 목적:
- 변경하지 않은 범위:
- 영향받는 module:
- 예상 및 실제 변경 file:
- Rule 영향:
- 예상 및 실제 logic 규모:
- Parallel 작업 충돌:

## Changes

- 변경 내용:
- 변경 이유:
- Architecture 또는 domain 영향:
- 사람이 집중해서 확인할 부분:

## Rule approval

- [ ] Rule 변경 없음
- [ ] Rule 변경이 있으며 첫 commit에 분리함
- 승인 comment:

## Red-Green evidence

- Red test commit:
- 기대한 실패 원인:
- Green implementation commit:
- 추가 test 또는 Reference commit:

## Logic budget

- Logic diff 규모:
- Budget 초과 여부와 이유:
- Test, mock, fixture, generated, markup 제외 범위:

## Validation

| Command                             | Result |
| ----------------------------------- | ------ |
| `pnpm --filter <package> test`      |        |
| `pnpm --filter <package> typecheck` |        |
| `pnpm --filter <package> lint`      |        |
| `pnpm --filter <package> build`     |        |

실행하지 못했거나 실패한 command와 이유:

## Risk and follow-up

- 남은 위험:
- 후속 Issue:
- Rollback 또는 복구 방법:

## Final checklist

- [ ] GitHub Issue의 acceptance criteria를 충족함
- [ ] 최종 PR head에서 관련 validation이 Green임
- [ ] Reference document를 실제 code와 일치시킴
- [ ] Unrelated refactoring을 포함하지 않음
- [ ] Secret, token, credential, 개인정보를 포함하지 않음
- [ ] AI는 이 PR을 merge하지 않음
