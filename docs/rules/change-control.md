---
type: rule
status: active
enforcement: approval-required
scope: repository
last-reviewed: 2026-09-08
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

## Dependency 선택과 비용

아래 정책과 다른 Rule의 연결 문구는 [PR #97의 사용자 승인](https://github.com/blahaj94/ldb/pull/97#issuecomment-5559626371)과 merge를 반영한 active Rule이다. 특정 library 선정·설치를 승인하지 않는다.

```yaml
status: active
enforcement: approval-required
rationale: dependency 제약을 지키려다 범용 기능의 자체 구현·검증 비용이 커지는 선택을 조기에 확인한다.
evidence: "Issue #96, PR #97 사용자 승인: https://github.com/blahaj94/ldb/pull/97#issuecomment-5559626371"
exceptions: 기존 기능이나 작은 native API 호출·단순 adapter로 요구를 충족하면 별도 비교 문서나 질문을 요구하지 않는다.
review-after: 승인 후 dependency 선택이 필요한 구현 Issue 3개에서 질문의 적시성과 비교 비용을 확인한다.
```

- 새 dependency의 사전 승인은 사용 금지나 자체 구현 우선 지시가 아니다. 승인 절차를 피하려고 library가 맡을 범용 기능을 직접 구현하지 않는다.
- Dependency 제약으로 범용 기능을 반복해서 만들거나 여러 공통 처리와 실패 경계 test를 직접 구성해야 해 구현·검증 부담이 커질 것으로 예상되면, 설계·착수 전에 아래 비교와 질문을 진행한다. 작업 도중 발견하면 해당 구현을 더 늘리기 전에 즉시 진행한다.
- 비교는 기존 repository 기능, native API, 유지보수되는 library와 직접 구현 중 해당 요구에 적합한 선택지를 필요한 범위에서 확인한다. 구현뿐 아니라 test·mock·review·유지보수 비용, 호환성·dependency 부담과 library 도입 후에도 남는 인증·응답 제한·경합 등 제품 정책을 함께 고려한다. 정밀한 비용 추정이나 포괄적인 library 조사를 의무화하지 않는다.
- 사용자에게 추천안과 실질적인 대안 1개, 각각의 trade-off를 짧게 제시하고 선택을 질문한다. Worker는 Planner에게 근거를 전달하고 선택에 영향받는 구현을 보류하며, 결정이 필요 없는 독립 작업은 계속할 수 있다. 질문만 하고 답변 전에 영향받는 자체 구현을 진행하지 않는다.
- Planner가 dependency 추가를 제외 범위로 정할 때는 사용자 지시·승인된 Rule·이번 작업 범위 등 근거를 Issue에 명시한다. 이유 없이 관행적으로 고정하거나 필요한 library 검토까지 생략하는 제약으로 사용하지 않는다. 외부 library 도입과 자체 공통 package 신설은 목적·비용·boundary가 다른 별도 판단이다.
- 명시적 사용자 금지와 승인된 runtime·API·security contract는 유지한다. 비용·요구 변화에 따른 기존 제한의 재검토는 제안할 수 있지만, 실제 dependency 설치·역할 변경이나 contract를 바꾸는 구현은 필요한 Rule 변경안의 Draft PR 승인과 해당 작업의 실행 허용 후에만 진행한다. 사용자의 후보 선택은 그 자체로 Rule 승인 evidence를 대신하지 않는다.

## Approval evidence

Rule 변경이 필요하면 AI는 다음 순서로 진행한다.

1. 변경 이유, 영향, 대안을 사용자에게 설명한다.
2. Draft PR의 첫 commit으로 Rule 변경안만 올린다.
3. Draft PR에서 사용자의 명시적인 `승인` comment를 기다린다.
4. 승인 후 같은 PR에서 [`testing.md`의 Red-Green workflow](testing.md#red-green-workflow)에 따라 필요한 검증·구현·Reference commit 순서로 진행한다.

승인 전 Rule 변경안은 proposal이며 implementation authority가 아니다.

## Issue and preflight

목표와 작업의 선택은 [`목표별 계획과 작업 착수`](task-planning.md)의 승인 상태와 기준을 따른다. 모든 개발 작업은 착수 전에 GitHub Execution Issue를 실행 계약의 source로 사용한다. AI는 구현 전에 Issue에 다음 preflight를 comment하고, approval boundary가 없으면 기다리지 않고 진행한다. 현재 contract에 이미 있는 항목은 해당 절 pointer로 연결하고 새 판단·변경분을 기록한다. 아래 항목의 확인과 필요한 승인·검증을 생략하지 않는다.

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

Project의 카드 이동은 preflight나 사용자 실행 지시를 대신하지 않는다. 승인된 Project 흐름으로 만든 Issue는 원래 목표와 선택한 작업을 연결한다.

Issue의 현재 실행 contract와 PR의 실제 변경·evidence는 [`Execution Issue`](agent-workflow.md#execution-issue)의 기록 기준을 따른다. Preflight는 현재 contract에서 연결하고 PR에는 그 이후 실제 차이와 검증 결과를 기록한다. 세부 구현 설계와 일시적인 작업 분해는 Issue comment와 PR에서 관리하며 permanent Rule document에 넣지 않는다.

## Branch, worktree, and parallel work

- main에서 직접 작업하지 않는다.
- Issue마다 하나의 통합 branch와 전용 `git worktree`를 사용한다. 해당 checkout의 편집·통합은 통합 담당 한 명만 수행하며 Runner의 검증 접근은 아래 예외를 따른다.
- 위임 수행의 각 Worker는 기록된 integration head에서 별도 branch와 `git worktree`를 만든다. 여러 editor나 terminal이 같은 checkout을 공유하지 않으며 Worker가 통합 branch에서 직접 구현하지 않는다.
- [PR #106에서 승인된](https://github.com/blahaj94/ldb/pull/106#issuecomment-5561177716) 단독 직접 수행은 [`수행 모드 선택`](agent-workflow.md#수행-모드-선택)의 모든 조건과 [`수행 모드와 소유권`](agent-execution.md#수행-모드와-소유권)의 기록을 충족한 유일한 editor인 parent만 Issue 통합 branch·전용 worktree에서 Worker와 통합을 겸하는 예외다. 복수 editor는 위임 수행과 별도 branch·worktree를 사용한다.
- Runner는 [`agent-runner.md`](agent-runner.md#parent가-확정할-실행-packet)에 따라 checkout owner가 입력을 고정한 배타적 검증 구간에만 대상 checkout에 접근한다. 이 접근은 여러 editor가 checkout을 공유할 권한이 아니다.
- Worker branch, 기준 commit, bounded scope와 통합 담당을 Issue body의 최신 roster와 일치시킨다. 구체적인 배정·상태·handoff는 [`agent-execution.md`](agent-execution.md)를 따른다.
- 같은 file, public contract, generated source·artifact, database·migration, test fixture·snapshot 또는 다른 shared state를 상충하게 변경할 가능성이 있으면 병렬 구현하지 않는다. File이 달라도 producer·consumer나 runtime state가 겹치면 같은 충돌로 본다.
- 위임 수행의 Worker는 result commit과 validation evidence를 반환한다. 통합 담당은 scope와 기준 commit을 확인한 뒤 통합 branch에 순서대로 반영한다. 단독 직접 수행도 result commit과 최종 head validation을 기록한다.
- Result base 이후 integration head가 전진했다면 textual conflict 유무와 별개로 중간 변경과의 semantic 관계를 확인한다. 관련 의미가 바뀐 stale result는 최신 head에서 Worker가 rebase·재검증한 뒤에만 반영한다.
- 예상하지 못한 semantic·logic conflict나 scope 누락을 발견하면 영향받는 scope를 멈추고 Planner와 사용자에게 보고한다. 필요한 승인과 범위 판단을 거친 뒤 관련 Worker에게 후속 작업을 배정하며 자동 해결하지 않는다.
- Formatting 또는 Reference document처럼 의미 변화가 없는 conflict는 통합 담당이 해결하고 결과를 보고할 수 있다.
- 다른 Issue의 PR이 먼저 merge되면 Issue 통합 branch를 최신 main으로 rebase하고 영향을 받은 Worker result와 최종 head의 전체 validation을 다시 실행한다.
- 최종 PR은 Issue 통합 branch의 검증된 exact head에서 만든다. Worker branch의 개별 성공이나 conflict-free 반영만으로 통합 validation을 대신하지 않는다. 검증 재사용은 [`testing.md`](testing.md#검증-evidence-재사용)를 따르며 이 최종 gate와 main rebase·semantic conflict 후 전체 validation을 대체하지 않는다.

## 브랜치 명명 규칙

이 절은 [Issue #179](https://github.com/blahaj94/ldb/issues/179)와 [PR #180의 사용자 승인](https://github.com/blahaj94/ldb/pull/180#issuecomment-5588308688)을 반영한 active Rule이다. 승인된 생성 동작을 반영한 checkout에서 새 작업 브랜치부터 적용한다. 기존 브랜치와 사용자 merge 권한은 유지한다.

```yaml
status: active
enforcement: approval-required
rationale: 작업 대상 workspace와 Issue를 브랜치 이름에서 일관되게 식별한다.
evidence: "https://github.com/blahaj94/ldb/pull/180#issuecomment-5588308688"
exceptions: 기존 브랜치는 이름을 유지하며 main은 작업 브랜치 명명 대상에서 제외한다.
review-after: 적용 후 서로 다른 Issue 5개에서 접두어 선택과 이름 충돌 사례를 확인한다.
```

### 형식과 작업 범위

작업 브랜치는 `{project}-{issue-number}-{description}`을 사용한다. project는 저장소 이름이나 agent 이름이 아니라 해당 브랜치가 책임지는 작업 범위다.

| project | 선택 기준 |
| --- | --- |
| `api` | `apps/api`가 주 작업 대상 |
| `desktop` | `apps/desktop`이 주 작업 대상 |
| `web` | `apps/web`이 주 작업 대상 |
| `ui` | `packages/ui`가 주 작업 대상 |
| `cross` | 둘 이상의 workspace에 걸친 변경이 Issue의 목적 |
| `repo` | 루트 설정·공통 scripts·CI·저장소 운영 규칙이 Issue의 목적 |

- 작업 범위는 변경 파일 수가 아니라 Issue의 목적과 맡은 책임으로 판단한다. 단일 workspace 작업에 따라 lockfile이나 설명 문서를 함께 갱신해도 `cross`로 바꾸지 않는다.
- issue-number는 현재 저장소의 실제 Issue 번호이며 0이나 선행 0을 사용하지 않는다. 새 작업 착수 시 OPEN Issue 확인은 유지한다.
- description은 작업을 나타내는 짧은 영어 소문자 설명이며 변경 동사부터 시작한다. 단어는 하이픈 하나로 연결하고 문자와 숫자만 사용한다. 예: `fix-character-search`, `add-login-window`, `update-search-page`.
- `codex/`, `feat/`, `fix/` 같은 별도 접두어, 작성자·모델 이름, 날짜를 앞에 추가하지 않는다.
- 이름은 생성 시 정하고, Issue 제목이나 보조 변경 파일이 달라져도 생성한 브랜치를 자동으로 바꾸지 않는다. 별도 목적이 생기면 기존 Issue 범위 규칙을 따른다.

```text
api-173-fix-character-search
desktop-174-add-login-window
web-175-update-search-page
ui-176-add-button-variant
cross-173-connect-character-search
repo-179-standardize-branch-names
```

예시의 번호는 형식을 설명하며 실제 생성에서는 담당 Issue 번호를 사용한다.

### 통합·Worker 브랜치와 적용

- Issue별 통합 브랜치 하나와 별도 worktree 원칙은 유지한다. 통합 브랜치의 project·description은 Issue 전체 목적을 나타낸다.
- 별도 Worker 브랜치도 같은 형식과 같은 Issue 번호를 사용하며, project·description은 배정된 작업 범위를 나타낸다. 예를 들어 통합이 `cross-173-connect-character-search`이면 Worker는 `api-173-add-search-endpoint`, `desktop-173-connect-search-api`처럼 구분한다.
- 같은 workspace에서 분담할 때는 description에 맡은 작업을 구분해 통합·다른 Worker 브랜치와 충돌하지 않게 한다. 이름과 책임은 기존 Issue roster에 기록하고, 충돌을 피하려고 임의 번호·agent 이름을 붙여 새 브랜치를 계속 만들지 않는다.
- 기존 로컬·원격 브랜치와 worktree는 일괄 변경하거나 삭제하지 않는다. 승인된 생성 동작을 반영한 뒤 새로 만드는 작업 브랜치부터 적용한다.
- 생성 스크립트는 project·Issue 번호·description을 명시적으로 받아 검증한다. 잘못된 입력과 기존 branch/path의 충돌은 새 branch/worktree 생성 전에 거절한다. 기존 OPEN Issue·최신 main 확인과 덮어쓰기 금지는 유지한다. 실행 인자와 예시는 구현 후 `scripts/README.md`에서 관리한다.

## Commit and PR order

같은 PR 안에서 필요한 만큼 commit을 나누되 다음 의미 순서를 지킨다.

1. `docs:` 승인 대상 Rule 변경안이 있을 때만
2. `test:` test 변경이 필요할 때. 구현 전 검증과 commit 적용 조건은 [`testing.md`의 Red-Green workflow](testing.md#red-green-workflow)를 따른다.
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
