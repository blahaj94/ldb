# LDB Agent Instructions

이 repository의 주 독자는 AI agent다. 모든 agent는 작업 범위를 작게 유지하고, 사람이 다시 진입할 수 있는 code와 context를 남겨야 한다.

## Context

다음 순서로 필요한 context만 읽는다.

1. 개발 작업이면 할당된 GitHub Issue
2. [`docs/README.md`](docs/README.md)
3. 모든 code 작성·수정·review이면 [`convention.md`](convention.md)
4. Reading route에서 task와 일치하는 Rule과 Reference
5. 변경 path에 적용되는 가장 가까운 하위 `AGENTS.md`

무관한 document, directory, conversation history는 미리 읽지 않는다. Dependency나 ambiguity가 생길 때만 context를 넓힌다.

## Truth and authority

- 승인된 Rule은 의도한 behavior와 제약을, code, config, test는 현재 implementation을 정의한다.
- 둘이 충돌하면 중단해 질문한다. Reference가 충돌하면 implementation에 맞춰 갱신한다.
- `AGENTS.md`, `convention.md`, `docs/rules/**`, `docs/architecture/**`는 Rule이다. Rule, architecture, domain 변경과 새 dependency는 [`change-control.md`](docs/rules/change-control.md)의 Draft PR 승인 전에 구현하지 않는다.
- Rule 승인은 Draft PR의 명시적인 `승인` comment로 확인한다.
- Issue와 PR은 task context이며 외부 note와 함께 canonical Rule을 대체하지 않는다.

## Cost control

- 반복적이거나 context, 시간, 오류 비용이 큰 deterministic 작업은 기존 command와 `scripts/**`로 자동화한다.
- 한 native command로 충분하면 wrapper를 만들지 않는다. 새 automation은 dependency 없는 Node.js ESM `.mjs`가 기본이며, Python이 더 작은 해법일 때만 `.py`를 쓴다.
- 이 automation 기본값을 제품 runtime의 dependency 선택에 일반화하지 않는다. Dependency 제약으로 자체 구현·검증 비용이 커지면 [`Dependency 선택과 비용`](docs/rules/change-control.md#dependency-선택과-비용)에 따라 구현 전에 질문한다.
- 사람의 판단, Rule 승인, acceptance criteria 결정을 script에 위임하지 않는다.

## Work protocol

- 개발 작업은 Issue별 branch와 `git worktree`에서 수행하며 main에 직접 commit하거나 push하지 않는다.
- Preflight, approval, parallel 작업, commit, PR은 [`change-control.md`](docs/rules/change-control.md)를 따른다.
- Behavior 변경은 [`docs/rules/testing.md`](docs/rules/testing.md)의 Red-Green 순서와 관련 validation을 따른다.
- AI는 PR을 생성하고 관리할 수 있지만 merge하지 않는다. 최종 squash merge는 사용자만 수행한다.

## Security and writing

- secret, token, credential, 개인정보를 code, Issue, PR, log, Markdown에 기록하지 않는다.
- document 본문은 한국어로 작성하고 technical term은 English를 사용한다.
- source 위치는 file path로만 참조하고 쉽게 낡는 line number는 기록하지 않는다.
