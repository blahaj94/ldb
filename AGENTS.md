# LDB Agent Instructions

작업 범위를 작게 유지하고, 사람이 이어받을 수 있는 code와 context를 남긴다.

## Context

현재 요청과 Issue에서 필요한 문서부터 읽는다. 개발 전에는 Issue의 현재 contract와 연결된 승인, preflight, evidence를 확인한다. Project의 목표나 작업을 지정받았다면 [task-planning.md](docs/rules/task-planning.md)에 따라 실행 Issue로 연결한다.

문서 선택은 [작업별 읽기 안내](docs/README.md#역할별-시작점)를 사용하고, 작업 path에 적용되는 가장 가까운 하위 `AGENTS.md`를 확인한다. 저장소 작업의 문서와 명령 진입점은 [ldb-workflow](.agents/skills/ldb-workflow/SKILL.md)에 있다. 모든 진입 문서를 순서대로 읽을 필요는 없지만 적용되는 Rule 본문, AC, 승인, 보안과 검증 의무는 확인한다.

동일 revision의 본문이 context에 있으면 재독하지 않는다. Base, 문서 revision, 적용 조건이 바뀌거나 내용이 불확실할 때 관련 본문을 재확인한다. Pointer나 제목만 확인한 것은 본문 확인이 아니다. 무관한 문서나 이력은 미리 읽지 않고 dependency나 불확실성이 생긴 범위만 넓힌다.

## Truth and authority

- Rule은 의도한 동작과 제약을, code·config·test는 현재 구현을 정의한다. 둘이 충돌하면 중단하고 질문하며 Reference는 구현에 맞춰 갱신한다. Rule의 위치와 문서 권위는 [Document class](docs/README.md#document-class)를 따른다. Issue·PR·외부 note는 canonical Rule을 대체하지 않는다.
- 요청·실행 허용 범위의 Rule과 구현은 같은 PR에 준비하며, 별도 승인 comment 없이 사용자의 merge로 최종 승인된다. Merge 전 변경을 다른 작업에 적용하지 않고, proposed 내용의 절차·link 수정만으로 채택하거나 status를 바꾸지 않는다. 채택 범위와 승인 근거는 [Approval evidence](docs/rules/change-control.md#approval-evidence)를 따른다.
- 새 dependency와 제품별 착수·환경·실행 조건은 [change-control.md](docs/rules/change-control.md)의 별도 경계를 따른다.

## Cost control

- 반복되거나 context, 시간, 오류 비용이 큰 deterministic 작업은 기존 command와 `scripts/**`로 자동화한다.
- Native command 하나로 충분하면 wrapper를 만들지 않는다. 새 automation은 dependency 없는 Node.js ESM `.mjs`가 기본이며, Python이 더 작은 해법일 때만 `.py`를 쓴다.
- 이 기본값을 제품 runtime dependency에 일반화하지 않는다. Dependency 제약으로 자체 구현 및 검증 비용이 커지면 [Dependency 선택과 비용](docs/rules/change-control.md#dependency-선택과-비용)에 따라 구현 전에 질문한다.
- 사람의 판단, Rule 승인, AC 결정을 script에 위임하지 않는다.

## Work protocol

- 개발은 Issue별 branch와 `git worktree`에서 수행하며 main에 직접 commit하거나 push하지 않는다.
- Preflight, approval, parallel 작업, commit, PR은 [change-control.md](docs/rules/change-control.md)를 따른다.
- Behavior 변경은 [testing.md](docs/rules/testing.md)의 Red-Green 순서와 관련 validation을 따른다.
- AI는 merge하지 않는다. 최종 squash merge는 사용자만 수행한다.

## Security and writing

- Secret, token, credential, 개인정보를 code, Issue, PR, log, Markdown에 기록하지 않는다.
- Source 위치는 file path로만 참조하고 line number는 기록하지 않는다.
- 사람이 읽는 설명을 작성할 때는 [writing.md의 공통 기준](docs/rules/writing.md#사람이-읽는-설명-작성-기준)을, GitHub 글을 작성하거나 수정할 때는 [GitHub 기준](docs/rules/writing.md#github-글의-문체와-형식)도 읽고 적용한다.
