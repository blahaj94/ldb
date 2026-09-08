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

#### GitHub 글의 문체와 형식 보완안

이 절은 [Issue #192](https://github.com/blahaj94/ldb/issues/192)의 규칙 변경안입니다. Draft PR의 명시적인 사용자 승인 전까지 `proposed`이며, 위의 승인된 작성 기준은 계속 적용합니다. 승인 후에는 위 기준과 함께 적용합니다.

```yaml
status: proposed
enforcement: warning
rationale: GitHub에서 AI가 작성하는 글의 문체와 형식을 통일해 필요한 정보와 다음 행동을 쉽게 파악하도록 합니다.
evidence: "사용자와 합의한 개선안: https://github.com/blahaj94/ldb/issues/192; Draft PR 승인 대기"
exceptions: 코드, 식별자, 명령어, schema field, 공식 명칭, 정확성이 필요한 원문 인용은 원래 표현을 유지합니다.
review-after: 승인 후 GitHub 글 3건을 작성했거나 사용자가 다시 읽기 어렵다고 지적하면 실제 사례로 기준과 예시를 재검토합니다.
```

**적용 범위와 우선순위**

- 이 기준은 GitHub에서 AI가 작성하거나 수정하는 모든 글에 적용합니다. Issue, Discussion, Project의 설명과 업데이트, PR 본문, 리뷰, 댓글 등을 포함합니다.
- 기존 글을 수정할 때는 해당 수정 범위에 적용합니다. 과거 글 전체를 일괄 수정할 의무를 만들지는 않습니다.
- 위의 한국어 사용, 핵심부터 설명하기, 완료 조건 작성, 사실과 추정 구분 기준을 함께 따릅니다. 정확성, 이해하기 쉬운 구조, 간결성, 문체의 일관성 순서로 판단합니다.
- `warning`은 위반을 지적하고 수정을 권고하는 수준입니다. 이 작성 기준만으로 작업을 자동 차단하지 않으며, 자동 검사 도구의 도입을 뜻하지 않습니다.
- 기존 필수 항목, 제목 형식, 상태 체계, 승인 절차, 검증과 보안 의무는 유지합니다. Issue 제목은 [`agent-workflow.md`의 Issue 제목](docs/rules/agent-workflow.md#issue-제목)을 따르며, 상태값은 적용되는 작업 절차와 Project의 기존 정의를 사용합니다.

**문체와 구조**

- 설명 문장은 `-합니다`, `-됩니다`, `-필요합니다` 형태의 존댓말로 통일합니다. 제목, 소제목, 상태값과 짧은 항목명은 명사형을 허용합니다.
- 일반적인 한국어 띄어쓰기를 지킵니다. 한 문장에는 가능한 한 하나의 핵심 내용을 담고, 내용이 달라지면 문장을 나눕니다. 주제가 달라지면 문단을 나누고 문단 사이에 한 줄을 비웁니다.
- 정보를 나열할 때는 쉼표나 Markdown 목록을 사용하며 `·`로 연결하지 않습니다. 항목이 많거나 길면 목록으로 나누고 같은 문장 구조로 작성합니다. 원문 보존 예외는 유지합니다.
- 제목에서 대상과 문제 또는 변경 내용을 드러냅니다. 본문은 핵심 내용, 현재 상태, 필요한 행동, 참고 자료 순서로 정리하되 상황에 필요한 내용만 작성합니다.
- 내용이 길면 문제, 재현 방법, 제안, 결정이 필요한 내용 등 목적에 맞는 소제목을 사용합니다. 기존 필수 항목을 보존하면서 불필요한 소제목은 추가하지 않습니다.
- 같은 설명을 다른 표현으로 반복하지 않습니다. 기존 논의는 링크로 연결하고 현재 판단에 필요한 내용만 요약합니다.

**링크와 인용**

- 링크에는 내용을 알 수 있는 이름을 붙이고 필요한 참고 이유를 덧붙입니다. 기본 형식은 `[의미 있는 제목](URL): 참고 이유`이며, 이름만으로 용도가 명확하면 중복 설명은 생략합니다.
- 여러 링크도 각각 의미 있는 이름으로 구분합니다. `1/1`, `1/2`, `2/2` 같은 순번만으로 링크를 식별하지 않습니다.
- 외부 자료는 먼저 읽고 현재 논의에 필요한 핵심 내용과 근거만 요약합니다. 전체 페이지, 문서, 댓글의 복사를 기본 동작으로 삼지 않습니다.
- 인용은 논의에 필요한 최소 범위로 제한하고 원본 링크를 함께 제공합니다. 오류 메시지, 재현 코드, 승인 문구처럼 정확한 원문이 필요한 부분은 보존합니다. 확인하지 못한 내용은 추측으로 채우지 않고 확인되지 않았음을 밝힙니다.

아래 예시는 GitHub 글에 적용할 표현을 보여줍니다. 기존 예시의 명사형과 서술형이 설명 문장의 존댓말 기준을 대체하지 않습니다.

| 상황 | 권장 표현 |
| --- | --- |
| 설명 문장 | 알림에는 알림을 발행한 시점의 상태를 담습니다. |
| 제목 또는 소제목 | 로그인 후 대시보드로 이동하지 않는 문제 |
| 원인 미확인 | 세션 만료 처리와 관련된 문제일 가능성이 있습니다. |
