---
type: rule
status: deprecated
enforcement: approval-required
scope: repository
last-reviewed: 2026-09-07
rationale: 승인된 제안의 이력과 canonical 위치를 보존하고 중복 active 계약을 남기지 않는다.
evidence: "Issue #105, PR #106 사용자 승인: https://github.com/blahaj94/ldb/pull/106#issuecomment-5561177716"
exceptions: 이 문서는 실행 authority가 아니며 연결된 active canonical Rule을 따른다.
review-after: agent-workflow.md의 실행 효율 계약의 재검토 조건을 따른다.
---

# Agent 실행 효율 제안 승인 이력

[Issue #105](https://github.com/blahaj94/ldb/issues/105)의 제안은 [PR #106의 명시적 사용자 승인](https://github.com/blahaj94/ldb/pull/106#issuecomment-5561177716)과 merge로 확정됐다. [Issue #107](https://github.com/blahaj94/ldb/issues/107)에서 아래 canonical Rule로 반영했으며 이 문서는 별도의 active 계약이 아니다. 제안 당시의 비교·대안·검토 evidence는 [PR #106](https://github.com/blahaj94/ldb/pull/106)에 보존한다.

| 승인된 핵심 결정 | Active canonical 위치 |
| --- | --- |
| 낮은 uncertainty·risk와 확정된 scope·기존 pattern·독립성에 한정한 parent 직접 수행 | [`agent-workflow.md`의 수행 모드 선택](agent-workflow.md#수행-모드-선택) |
| 단독 parent의 Worker slot 1개·Issue 통합 checkout 예외, 위임 mode 격리·전환·소유권 | [`agent-execution.md`의 수행 모드와 소유권](agent-execution.md#수행-모드와-소유권), [`change-control.md`의 branch·worktree 규칙](change-control.md#branch-worktree-and-parallel-work) |
| Worker count 밖의 실행 보조와 단일 job owner·입력 고정·handle·종료·취소·retry·고정 report | [`agent-execution.md`의 실행 보조 기록](agent-execution.md#실행-보조-기록), [`agent-runner.md`](agent-runner.md) |
| 입력 근거가 있는 PASS 재사용·aggregate 중복 생략·실패 영향 범위 재검증, 필수 gate 유지 | [`testing.md`의 검증 evidence 재사용](testing.md#검증-evidence-재사용) |
| 당시 모델 mapping 보존과 실험·adapter 설치 분리의 승인 이력. 현재 모델 선택은 연결된 canonical 기준 적용 | [`agent-workflow.md`의 Code Worker runtime mapping](agent-workflow.md#code-worker-runtime-mapping), [실행 효율 계약의 재검토](agent-workflow.md#실행-효율-계약의-재검토) |

실제 Execution Issue 3개 후의 관측과 미검증 사례·효과를 추정하지 않는 기준도 위 canonical 재검토 절에서 관리한다.
