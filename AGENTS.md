# LDB Agent Instructions

이 repository의 주 독자는 AI agent다. 모든 agent는 작업 범위를 작게 유지하고, 사람이 다시 진입할 수 있는 code와 context를 남겨야 한다.

## Context

다음 순서로 필요한 context만 읽는다.

1. Project 작업을 요청받으면 승인된 [`task-planning.md`](docs/rules/task-planning.md)에 따라 해당 목표와 작업에서 실행 Issue로 연결한다. 개발 착수 시 해당 Issue의 현재 contract와 연결된 승인·evidence를 확인한다. 제안 상태이면 기존 Issue 진입 절차를 유지한다.
2. [`docs/README.md`](docs/README.md)의 Document class와 Reading route
3. Reading route의 역할별 시작 문서·절에서 시작해 task와 일치하는 topic의 Rule과 Reference
4. 작업 path에 적용되는 가장 가까운 하위 `AGENTS.md`

이미 제공받거나 확인한 동일 revision의 본문이 현재 context에 있으면 재독하지 않는다. Base·문서 revision·적용 조건이 바뀌었거나 기억이 불확실하거나 context를 잃었으면 관련 본문을 재확인한다. Pointer만 받았거나 제목만 확인한 것은 본문을 읽은 것으로 보지 않는다.

무관한 document, directory, conversation history는 미리 읽지 않는다. Dependency나 ambiguity가 생기면 관련 context만 넓힌다. Context 축소를 이유로 적용되는 Rule·AC·승인·보안·검증 의무를 생략하지 않는다.

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
- source 위치는 file path로만 참조하고 쉽게 낡는 line number는 기록하지 않는다.

### 작성 기준

사람이 읽는 설명을 작성할 때는 [`writing.md`의 공통 기준](docs/rules/writing.md#사람이-읽는-설명-작성-기준)을, GitHub 글을 작성하거나 수정할 때는 [GitHub 기준](docs/rules/writing.md#github-글의-문체와-형식)도 읽고 적용한다. 동일 revision을 이미 확인했으면 재독하지 않는다.
