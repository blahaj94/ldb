# LDB Agent Instructions

이 repository의 주 독자는 AI agent다. 모든 agent는 작업 범위를 작게 유지하고, 사람이 다시 진입할 수 있는 code와 context를 남겨야 한다.

## Source of truth

- 승인된 Rule document는 의도한 behavior와 제약을 정의한다.
- 실행되는 code, config, test는 현재 implementation의 사실을 보여준다.
- Rule document와 implementation이 충돌하면 어느 한쪽을 임의로 정답으로 선택하지 않고 작업을 중단해 사용자에게 질문한다.
- Reference document가 implementation과 충돌하면 code, config, test에 맞춰 Reference document를 갱신한다.
- GitHub Issue와 PR은 task context이며 permanent Rule을 대체하지 않는다.
- Obsidian을 포함한 외부 note는 논의 공간이며 repository의 canonical source가 아니다.

## Required reading

작업을 시작하기 전에 다음 순서로 읽는다.

1. 할당된 GitHub Issue
2. [`docs/README.md`](docs/README.md)
3. [`docs/rules/change-control.md`](docs/rules/change-control.md)
4. [`docs/rules/testing.md`](docs/rules/testing.md)
5. [`docs/rules/code-quality.md`](docs/rules/code-quality.md)
6. 작업과 관련된 Architecture 또는 Reference document

필요한 document만 읽고, repository 전체를 매번 context로 적재하지 않는다.

## Authority boundary

- `AGENTS.md`, `docs/rules/**`, `docs/architecture/**`는 Rule document다.
- Rule, architecture, domain을 변경하거나 새 dependency를 추가하려면 사용자 승인이 필요하다.
- AI는 Rule 변경을 언제든 제안할 수 있지만 승인 전에 관련 구현을 진행하지 않는다.
- `docs/reference/**`는 Reference document다. AI가 실제 code와 일치하도록 자율적으로 갱신한다.
- Rule 승인은 Draft PR의 명시적인 `승인` comment로 확인한다.

## Work protocol

- main에 직접 commit하거나 push하지 않는다.
- GitHub Issue마다 별도 branch와 `git worktree`를 사용한다.
- AI는 Issue에 preflight를 남기고, approval boundary에 해당하지 않으면 별도 승인 없이 진행한다.
- Rule 변경이 필요하면 Draft PR에 Rule commit을 먼저 올리고 승인을 기다린다.
- behavior 구현은 실패하는 test commit인 Red가 먼저고, implementation commit인 Green이 뒤따른다.
- 최종 PR head는 관련 test, typecheck, lint, build를 통과해야 한다.
- AI는 PR을 생성하고 관리할 수 있지만 merge하지 않는다. 최종 merge는 사용자만 수행한다.
- main에는 squash merge한다.

상세한 중단 조건, parallel 작업, commit 순서는 [`docs/rules/change-control.md`](docs/rules/change-control.md)를 따른다.

## Security and writing

- secret, token, credential, 개인정보를 code, Issue, PR, log, Markdown에 기록하지 않는다.
- document 본문은 한국어로 작성하고 technical term은 English를 사용한다.
- source 위치는 file path로만 참조하고 쉽게 낡는 line number는 기록하지 않는다.
