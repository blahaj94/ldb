---
type: rule
status: active
enforcement: approval-required
scope: repository
last-reviewed: 2026-08-28
---

# Change Control

## Ownership

- 사용자는 Rule과 architecture의 최종 결정 및 GitHub merge 권한을 가진다.
- AI는 GitHub Issue 범위 안에서 code, test, Reference document를 자율적으로 변경하고 commit할 수 있다.
- AI는 Issue comment, label, Draft PR, PR을 작업 상태에 맞게 관리할 수 있다.
- AI가 작업 속도나 품질을 개선할 운영 변경을 발견하면 언제든 사용자에게 제안할 수 있다.

## Approval required

다음 변경은 구현 전에 중단하고 사용자에게 설명한 뒤 승인을 받는다.

- `AGENTS.md`, Rule document, architecture document, domain rule 변경
- 새로운 dependency 추가 또는 기존 dependency의 역할 변경
- database schema 또는 migration 전략 변경
- API contract 변경
- app 사이의 통신 방식 또는 architecture boundary 변경
- authentication, authorization, security 동작 변경
- 기존 user-visible behavior 변경
- 기존 module 전체 교체
- GitHub Issue 범위를 벗어난 refactoring
- 사용자의 선택과 책임이 필요한 ambiguity

두 개 이상의 app을 변경한다는 사실만으로 중단하지 않는다. 위 approval boundary를 건드릴 때 중단한다.

## Approval evidence

Rule 변경이 필요하면 AI는 다음 순서로 진행한다.

1. 변경 이유, 영향, 대안을 사용자에게 설명한다.
2. Draft PR의 첫 commit으로 Rule 변경안만 올린다.
3. Draft PR에서 사용자의 명시적인 `승인` comment를 기다린다.
4. 승인 후 같은 PR에 Red, Green, Reference commit을 순서대로 추가한다.

승인 전 Rule 변경안은 proposal이며 implementation authority가 아니다.

## Issue and preflight

모든 개발 작업은 GitHub Issue를 source로 사용한다. AI는 구현 전에 Issue에 다음 preflight를 comment하고, approval boundary가 없으면 기다리지 않고 진행한다.

```text
목적
변경하지 않을 범위
영향받는 module
예상 변경 file
Rule 영향
예상 logic 규모
test 전략
검증 command
parallel 작업 충돌 가능성
```

Issue는 Goal, user-visible behavior, acceptance criteria, in scope, out of scope, 관련 Rule, dependency, constraint를 제공한다. 세부 구현 설계와 일시적인 작업 분해는 Issue comment와 PR에서 관리하며 permanent Rule document에 넣지 않는다.

## Branch, worktree, and parallel work

- main에서 직접 작업하지 않는다.
- Issue마다 하나의 통합 branch와 전용 `git worktree`를 사용하고 통합 담당 한 명만 해당 checkout을 변경한다.
- 각 Worker는 기록된 integration head에서 별도 branch와 `git worktree`를 만든다. 여러 terminal이나 agent가 같은 checkout을 공유하지 않으며 Worker가 통합 branch에서 직접 구현하지 않는다.
- Worker branch, 기준 commit, bounded scope와 통합 담당을 Issue body의 최신 roster와 일치시킨다. 구체적인 배정·상태·handoff는 [`agent-execution.md`](agent-execution.md)를 따른다.
- 같은 file, public contract, generated source·artifact, database·migration, test fixture·snapshot 또는 다른 shared state를 상충하게 변경할 가능성이 있으면 병렬 구현하지 않는다. File이 달라도 producer·consumer나 runtime state가 겹치면 같은 충돌로 본다.
- Worker는 result commit과 validation evidence를 반환한다. 통합 담당은 scope와 기준 commit을 확인한 뒤 통합 branch에 순서대로 반영한다.
- Result base 이후 integration head가 전진했다면 textual conflict 유무와 별개로 중간 변경과의 semantic 관계를 확인한다. 관련 의미가 바뀐 stale result는 최신 head에서 Worker가 rebase·재검증한 뒤에만 반영한다.
- 예상하지 못한 semantic·logic conflict나 scope 누락을 발견하면 영향받는 scope를 멈추고 Planner와 사용자에게 보고한다. 필요한 승인과 범위 판단을 거친 뒤 관련 Worker에게 후속 작업을 배정하며 자동 해결하지 않는다.
- Formatting 또는 Reference document처럼 의미 변화가 없는 conflict는 통합 담당이 해결하고 결과를 보고할 수 있다.
- 다른 Issue의 PR이 먼저 merge되면 Issue 통합 branch를 최신 main으로 rebase하고 영향을 받은 Worker result와 최종 head의 전체 validation을 다시 실행한다.
- 최종 PR은 Issue 통합 branch의 검증된 exact head에서 만든다. Worker branch의 개별 성공이나 conflict-free 반영만으로 통합 validation을 대신하지 않는다.

## Commit and PR order

같은 PR 안에서 필요한 만큼 commit을 나누되 다음 의미 순서를 지킨다.

1. `docs:` 승인 대상 Rule 변경안이 있을 때만
2. `test:` 아직 구현되지 않은 behavior를 증명하는 Red test
3. `feat:` 또는 `refactor:` Green implementation
4. 추가 `test:`, `docs:` Reference 갱신 등

- Logic commit은 [`code-quality.md`](code-quality.md)의 logic budget을 따른다.
- 최종 PR head는 Green 상태여야 한다.
- AI는 PR을 Draft 또는 review-ready 상태로 만들 수 있지만 merge하지 않는다.
- 사용자가 GitHub에서 squash merge한다.
- PR은 하나의 Issue 목적에 집중한다. 새로운 목적이 필요하면 AI가 분리를 제안하고 사용자가 결정한다.

## Existing failures

기존 test, typecheck, lint, build 실패를 발견하면 원인을 확인하고 PR에 공개한다. 다음 행동은 금지한다.

- 실패를 숨기기
- test를 임의로 skip 또는 disable하기
- 관련 없는 fix를 현재 Issue에 섞기
- 검증하지 않고 성공으로 보고하기

관련 없는 기존 실패로 최종 validation이 불가능하면 PR을 Draft로 유지하고 사용자가 merge 가능 여부를 결정한다.

## Security and repository visibility

Repository는 현재 private이지만 MVP 이후 public 전환을 전제로 작성한다. 다음 정보는 visibility와 무관하게 code, commit, Issue, PR, log, Markdown에 기록하지 않는다.

- secret과 token
- 실제 credential 또는 private key
- 개인정보
- 외부 공개가 허용되지 않은 운영 data

예제가 필요하면 실제 값이 아닌 명확한 placeholder를 사용한다.
