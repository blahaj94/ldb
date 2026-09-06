## Related Issue

- Closes #

Issue는 현재 실행 contract를, PR은 실제 변경과 AC별 evidence를 기록합니다. 기록 기준은 [Execution Issue](../docs/rules/agent-workflow.md#execution-issue)를 따릅니다. 기존 contract·preflight·roster는 pointer로 연결하고 차이와 결과만 작성합니다. 아래 승인·검증·review 항목은 유지하며 해당하지 않는 항목에는 이유를 적습니다.

## Actual changes

- 현재 Issue contract·preflight pointer:
- 실제 변경과 이유:
- 계획 대비 scope·file·Rule·logic·parallel 충돌의 차이:

## Worker handoff

- AC별 결과·evidence:
- Worker별 채택 result commit:
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

## Review

- First-pass review 결과:
- Finding과 처리 결과:
- Escalation 필요 여부와 이유:
- High-capability 또는 human review 결과:

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
