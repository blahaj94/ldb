# LDB Agent Instructions

작업 범위를 작게 유지하고, 사람이 이어받을 수 있는 code와 context를 남긴다.

## Context

개발 전 Issue의 현재 contract, 승인, preflight와 evidence를 확인한다. Project 작업은 [task-planning.md](docs/rules/task-planning.md)에 따라 실행 Issue로 연결한다.

[읽기 안내](docs/README.md#역할별-시작점)에서 작업에 필요한 Rule 본문을 선택하고 작업 path의 가장 가까운 하위 `AGENTS.md`를 확인한다. 명령 진입점은 [ldb-workflow](.agents/skills/ldb-workflow/SKILL.md)에 있다. 무관한 문서·이력은 미리 읽지 않으며 적용되는 의무는 생략하지 않는다.

Context에 있는 동일 revision의 본문은 재독하지 않는다. Base·문서·적용 조건이 바뀌거나 불확실할 때 관련 본문을 재확인한다. 제목·pointer 확인은 본문 읽기를 대신하지 않는다.

## Truth and authority

- [Rule](docs/README.md#document-class)은 동작·제약을, code·config·test는 현재 구현을 정의한다. 충돌하면 중단하고 질문하며 Reference는 구현에 맞춘다. Issue·PR·외부 note는 Rule을 대체하지 않는다.
- 허용 범위의 Rule과 구현은 같은 PR에 준비하며 별도 승인 comment 없이 사용자 merge로 승인된다. Merge 전 다른 작업에 적용하지 않고, proposed 내용의 절차·link 수정만으로 채택하거나 status를 바꾸지 않는다.
- 승인 절차, 새 dependency와 제품별 착수·환경·실행 조건은 [change-control.md](docs/rules/change-control.md)를 따른다.

## Cost control

- 반복되거나 비용이 큰 deterministic 작업은 기존 command와 `scripts/**`로 자동화한다. Native command로 충분하면 wrapper를 만들지 않는다.
- 새 automation은 dependency 없는 Node.js ESM `.mjs`를 기본으로 하며 Python이 더 작은 해법일 때만 `.py`를 쓴다. 제품 runtime에 일반화하지 않는다.
- Dependency 제약으로 자체 구현·검증 비용이 커지면 [Dependency 선택과 비용](docs/rules/change-control.md#dependency-선택과-비용)에 따라 구현 전에 질문한다.
- 사람의 판단, Rule 승인, AC 결정을 script에 위임하지 않는다.

## Work protocol

- Issue별 branch와 `git worktree`에서 개발하며 main에 직접 commit·push하지 않는다.
- Preflight, 병렬 작업, commit과 PR은 [change-control.md](docs/rules/change-control.md)를 따른다.
- Behavior 변경은 [testing.md](docs/rules/testing.md)의 Red-Green과 validation을 따른다.
- 최종 squash merge는 사용자만 수행한다.

## Security and writing

- Secret, token, credential, 개인정보는 code·Issue·PR·log·Markdown에 기록하지 않는다.
- Source는 file path로만 참조하고 line number는 기록하지 않는다.
- 설명에는 [공통 작성 기준](docs/rules/writing.md#사람이-읽는-설명-작성-기준)을, GitHub 글에는 [GitHub 기준](docs/rules/writing.md#github-글의-문체와-형식)도 적용한다.
