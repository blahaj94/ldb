# LDB Agent Instructions

이 repository의 주 독자는 AI agent다. 모든 agent는 작업 범위를 작게 유지하고, 사람이 다시 진입할 수 있는 code와 context를 남겨야 한다.

## Context

다음 순서로 필요한 context만 읽는다.

1. 개발 작업이면 할당된 GitHub Issue의 현재 contract와 연결된 승인·evidence
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

아래 기준은 [PR #123의 사용자 승인](https://github.com/blahaj94/ldb/pull/123#issuecomment-5571663306)과 merge를 반영해 적용한다. 기존 승인·검증·보안 의무는 유지한다.

#### 사람이 읽는 설명 작성 기준

사용자에게 보내는 답변과 문서 본문, Issue·PR·인계 설명에 적용한다.

```yaml
status: active
enforcement: warning
rationale: 불필요한 영어 작업 분류와 압축 표현을 줄여 사용자가 한 번에 이해할 수 있게 한다.
evidence: "사용자 피드백: https://github.com/blahaj94/ldb/issues/122; PR #123 사용자 승인: https://github.com/blahaj94/ldb/pull/123#issuecomment-5571663306"
exceptions: 정확한 식별자·명령어·schema field와 확인에 필요한 원문은 그대로 유지한다.
review-after: 승인 후 실제 답변·Issue·PR·인계 설명 중 3건을 작성했거나 사용자가 다시 읽기 어렵다고 지적하면, 해당 사례를 바탕으로 기준과 예시를 재검토한다.
```

- 설명 수준은 질문과 대화 맥락에 맞춘다. 이미 이해한 개념은 반복해서 풀이하지 않는다.
- 본문은 자연스러운 한국어로 쓴다. 익숙한 개발 용어는 유지하고 불필요한 영어 작업 분류나 압축 표현은 풀어 쓴다.
- 결론이나 기대하는 변화를 먼저 말하고, 이해와 판단에 필요한 근거를 이어서 설명한다.
- 완료 조건은 구체적인 상황과 기대하는 결과를 짝지어 쓴다. 독립된 조건은 문장이나 항목을 나눈다.
- 짧게 쓰더라도 중요한 조건과 순서, 실패 가능성은 생략하지 않는다.
- 확인한 사실과 추정을 구분하고, 확인하지 않은 결과를 확정해서 말하지 않는다.
- 뜻이 확인되지 않은 내부 용어는 의미를 지어내지 않는다. 필요한 원문을 유지하고 확인이 필요한 부분을 밝힌다.
- code 식별자·명령어·schema field와 검증에 필요한 식별자는 정확히 유지한다.

아래 예시는 표현을 비교하며 제품 동작이나 기존 Issue의 완료 조건을 새로 정하지 않는다.

| 수정 전 | 수정 후 |
| --- | --- |
| `consequential finding 없음` | 이번 검토에서는 수정이 필요한 중요한 문제를 발견하지 못했습니다. |
| 알림 발행 당시의 snapshot 유지 | 알림에는 알림을 발행한 시점의 상태를 담는다. |
