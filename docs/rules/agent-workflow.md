---
type: rule
status: active
enforcement: approval-required
scope: repository
last-reviewed: 2026-09-07
rationale: 작은 GitHub Issue의 책임과 Worker 배정·완료를 명확히 하여 중복 착수와 agent 사이의 context·비용을 제한한다.
evidence: "GitHub Issue #26, #44, #79, #81"
exceptions: 긴급 작업도 change-control approval boundary와 사용자 merge 권한은 생략하지 않는다.
review-after: Execution Issue 10개 적용 후
---

# Agent Workflow

## 목적

큰 개발 요청을 Planner, Worker, Reviewer가 원래 대화 없이 이어받을 수 있는 작은 task로 바꾼다. 계획에서 실행으로 넘어가는 기록별 책임은 [`목표별 계획과 작업 착수`](task-planning.md)의 승인 상태와 기준을 따른다. 실행 단계에서는 GitHub Issue와 Pull Request가 durable coordination artifact이며 conversation history는 source of truth가 아니다.

이 문서는 역할, Issue contract와 model tier를 정의한다. 배정·상태·handoff·통합 계약은 [`agent-execution.md`](agent-execution.md), approval·branch·worktree·commit·merge 절차는 [`change-control.md`](change-control.md), test evidence는 [`testing.md`](testing.md), context와 logic budget은 [`code-quality.md`](code-quality.md)를 따른다.

## 역할과 단일 책임

### Planner

- 사용자가 지정한 repository 전체의 활성 Planner 한 명이 Issue contract, 배정, 상태 전이와 결과 검토를 순서대로 관리한다. 대화나 terminal마다 별도 Planner를 자동으로 두지 않는다.
- 여러 독립 결과나 architecture 판단이 필요한 큰 요청만 분해한다. 이미 bounded한 요청에는 별도 planning 단계를 만들지 않는다.
- Dependency 제외 범위의 근거와 library·자체 공통 package의 별도 판단은 [`Dependency 선택과 비용`](change-control.md#dependency-선택과-비용)을 따른다. 비용 증가를 예상하면 설계·배정 전에 사용자 선택이 필요한지 확인한다.
- 메인 context에는 오래 유지할 요구, 확정된 결정, 배정, dependency와 결과 evidence를 둔다. 위임 수행에서는 code 탐색·구현·test의 상세 context를 Worker에게 맡긴다.
- Planner의 Worker 겸임은 아래 수행 모드 선택의 조건을 모두 만족하는 단독 직접 수행에서만 허용한다. 위임 수행에서는 직접 code 탐색·구현·test를 수행하거나 같은 탐색과 raw log 재검토로 대기를 채우지 않고 상세 작업을 별도 Worker context에 둔다.
- High-capability model은 큰 작업의 decomposition, architecture, security, 높은 uncertainty 판단에 사용한다.

### Worker

- 하나의 bounded scope만 수행하고 필요한 context를 점진적으로 읽는다. 같은 Issue 안에서도 배정되지 않은 다른 Worker 범위를 맡지 않는다.
- Issue 범위, approval boundary, dependency와 최신 roster를 확인한 뒤 자신의 branch와 worktree에서 작업한다.
- Acceptance criteria를 validation evidence로 검증하고 commit과 짧은 결과를 통합 담당에게 반환한다.
- Scope를 임의로 늘리거나 architecture ambiguity를 추측으로 해결하지 않는다.
- Dependency 제약으로 자체 구현·검증 부담이 커지는 것을 발견하면 [`Dependency 선택과 비용`](change-control.md#dependency-선택과-비용)에 따라 즉시 보고하고 사용자 선택을 요청한다. 해당 선택에 영향받는 구현만 보류하며 결정이 필요 없는 독립 작업은 계속할 수 있다.

### 통합 담당

- Issue마다 한 명을 지정한다. Issue 통합 branch와 결과 채택 순서, 충돌 처리, 최종 head validation을 책임진다.
- Worker의 상세 탐색을 다시 수행하지 않고 bounded result, diff와 validation evidence를 검토한다.
- 위임 수행의 통합 담당은 semantic conflict나 누락을 직접 구현해 메우지 않고 관련 Worker에게 같은 범위의 후속 작업으로 돌려보낸다. 메인이 아닌 통합 담당이 수정까지 맡아야 하면 별도 bounded Worker scope로 정식 배정하고 roster에 기록한다.
- Planner가 통합 담당을 겸할 수 있다. 위임 수행에서는 branch 조정·결과 검토·validation만 맡고 상세 code 탐색·구현·test는 Worker context에 둔다. 단독 직접 수행에서는 아래 조건과 정식 Worker slot 안에서만 구현을 겸하며, 배정·승인·완료 기록의 단일 책임을 유지한다.

### Reviewer

- Issue acceptance criteria, 통합된 diff, validation result와 concise Worker summary를 기준으로 consequential defect를 찾는다.
- Worker conversation, 전체 reasoning과 shell history를 요구하지 않는다.
- Low-cost first-pass review를 기본으로 하고 escalation 조건에 해당할 때만 high-capability reviewer 또는 사람에게 넘긴다.
- Agent Reviewer는 Approve와 merge를 수행하지 않는다.

#### Code review model proposal

사용자 승인에 따라 repository code Reviewer의 1차 검토·재검토·필요한 AI 최종 검토를 `gpt-6-astra`, reasoning effort `medium`으로 고정한다. 이 mapping은 사용자 승인 후 code review에 우선 적용하며, 다만 현재 task에서 사용자가 명시한 이 model·effort 선택은 기존 사용자 선택 우선 규칙에 따라 즉시 적용하고 같은 선택을 다시 승인받지 않는다. 코드가 없는 문서의 1차 review는 저비용 경로를 유지하고, [`Convention migration proposal`](#convention-migration-proposal)의 code 작성·조사·분할·통합 조정에는 적용하지 않는다.

```yaml
status: active
enforcement: approval-required
rationale: repository code review의 설정과 검토 품질을 일관되게 확인한다.
evidence: "https://github.com/blahaj94/ldb/pull/150#issuecomment-5580132558"
exceptions: 사용자 선택 우선, 실제 설정 확인·가용성 보류, 사람 최종 판단과 사용자 merge 전 code 이행 금지는 이 문서의 해당 절을 따른다.
review-after: 승인 후 서로 다른 code review 3건에서 설정 적용·누락·검토 품질을 확인한다.
```

배정·착수 전에 실제 model과 effort 선택을 확인한다. 사용할 수 없거나 확인할 수 없으면 해당 review 배정과 완료 판정을 보류하고 가용성 문제를 보고하며, 다른 설정으로 대체하거나 high·ultra로 상향하지 않는다. 외부 review나 model 설정을 확인할 수 없는 결과는 이 고정 mapping의 적용 evidence로 사용하지 않는다. 예상 밖 실패·범위 초과·검증 불가·retry 소진은 기존 retry와 escalation을 따르되 자동 상향하지 않고 사람에게 판단을 요청한다. 사용자가 다른 model 또는 effort를 명시하면 그 선택이 우선하며, validation·사람의 최종 판단·Rule 승인·사용자 merge 경계는 유지한다.

## 수행 모드 선택

이 절의 직접 수행 예외와 실행 효율 계약은 [PR #106의 사용자 승인](https://github.com/blahaj94/ldb/pull/106#issuecomment-5561177716)과 merge를 반영한다. 여기서 parent는 현재 Issue의 Planner다.

직접 수행은 다음 조건을 모두 만족할 때만 선택한다.

- Scope와 AC가 승인된 결정·기존 Rule 안에서 확정됐고 필요한 실행 허용과 preflight가 있다.
- 기존 pattern으로 처리할 수 있으며 uncertainty와 risk가 모두 `low`다. 단순해 보여도 새 의미·설계 판단이 필요하면 이 조건을 충족하지 않는다.
- 관련 context가 bounded하고 별도 Worker context 유지의 이점보다 위임·인계·검토 비용이 크다고 짧게 설명할 수 있다.
- 다른 미완료 Worker 산출물과 결합하지 않고 file·public contract·generated output·port·DB 등 shared state와 충돌하지 않는다.
- High-risk, architecture, security, Rule 변경의 즉석 직접 구현 예외로 사용하지 않는다. 승인·dependency 선택·Red-Green·review 경계는 그대로다.

단독 직접 수행과 위임 수행의 roster·branch·통합 책임 및 전환은 [`수행 모드와 소유권`](agent-execution.md#수행-모드와-소유권)을 따른다. 단독 parent도 Issue·승인·preflight·검증·review·완료 기록을 생략하지 않는다.

긴 command라는 이유만으로 위임하지 않는다. Parent가 다른 독립 판단을 계속할 수 있는지, packet 작성·실행 시작·대기·인계·review·오류 복구까지의 비용이 줄어드는지 비교한다. 시간이나 변경 줄 수만으로 수행 모드를 고르지 않는다.

## Issue 종류

### 사람이 읽는 설명과 접힌 실행 정보

이 절은 [PR #195의 사용자 승인](https://github.com/blahaj94/ldb/pull/195#issuecomment-5589733046)을 반영한 active Rule입니다.

```yaml
status: active
enforcement: warning
rationale: 사람이 첫 설명만 읽어도 작업의 이유와 변경 방향을 이해하고 필요한 판단에 참여할 수 있도록 합니다.
evidence: "https://github.com/blahaj94/ldb/pull/195#issuecomment-5589733046"
exceptions: 정확한 원문과 식별자는 유지합니다. 기존 Issue 정리에서는 기록 보존을 위해 당시 본문을 수정하지 않고 접힌 영역에 둡니다.
review-after: 새 Issue 3개와 기존 Issue 정리 사례에서 설명만으로 작업 방향과 판단 사항을 이해할 수 있는지 검토합니다.
```

- AI가 Issue를 작성하거나 본문을 정리할 때 맨 위에 `작업 설명`을 둡니다. 문제와 작업이 필요한 이유, 주요 변경, 완료 후 달라지는 점을 자연스러운 한국어로 연결합니다. 보통 2~3문단으로 작성하되 중요한 조건을 생략하면서 분량을 맞추지 않습니다.
- 세부 항목을 압축해 나열하거나 목표 한 줄을 반복하지 않습니다. 그 작업을 모르는 사람도 변경 방향에 동의하거나 의견을 낼 수 있도록 구체적인 대상과 변경을 설명합니다. 일반 문체와 링크는 [`writing.md`](writing.md)를 따릅니다.
- 제안과 확정된 결정, 계획과 확인한 결과를 구분합니다. 승인이나 선택이 필요하면 판단할 사항과 제안 이유를 바깥에 씁니다. 미완료, 구현 보류, 미검증 등 중요한 조건도 접힌 영역에만 두지 않습니다. 필요한 경우 `확인이 필요한 사항` 소제목을 사용하며, 판단 요청이 없으면 형식적인 항목을 추가하지 않습니다.
- 상세 정보는 `<details>`와 `<summary>AI 작업 상세</summary>`로 묶고 기본적으로 접습니다. HTML 태그와 Markdown 본문 사이에 빈 줄을 둡니다. 에이전트는 접힘 여부와 관계없이 전체 본문과 연결된 근거를 읽습니다.
- Execution Issue의 기존 필수 정보, 현재 계약과 배정의 본문 관리, 승인과 검증 의무를 유지합니다. 설계 Issue와 부모 추적 Issue는 자신의 종류에 필요한 내용을 담으며 불필요한 Worker 배정을 만들지 않습니다.
- 바깥 설명과 상세 정보가 같은 현재 결정을 다루면 서로 일치하게 갱신합니다. 불일치를 발견하면 어느 한쪽을 임의로 실행 근거로 선택하지 않고 관련 승인과 근거를 확인합니다. 해결되지 않으면 영향받는 작업을 보류하고 사용자에게 확인합니다.
- AI 작성용 작업 템플릿은 `.github/ISSUE_TEMPLATE/task.yml` 대신 `.github/ISSUE_TEMPLATE/task.md`로 제공합니다. Markdown 템플릿은 필수 입력 검증을 자동 강제하지 않으므로 AI가 게시 전에 기존 필수 정보와 보안 의무의 충족 여부를 확인합니다. GitHub API나 CLI로 작성할 때도 같은 본문 구조를 적용합니다.

본문의 항목과 AI 작성 안내는 [작업 템플릿](../../.github/ISSUE_TEMPLATE/task.md)에서 확인합니다.

**기존 Issue 정리**

Issue #194에서는 착수 시 확인한 기존 Issue 87개를 열린 상태와 닫힌 상태 모두 포함해 정리합니다. 본문을 개별 검토해 사람용 설명을 작성하고, 원래 본문 전체는 접힌 영역에 보존합니다. 이미 접힌 영역이 있으면 중복이나 표시 오류를 개별 확인합니다. 닫히지 않은 코드 펜스나 HTML 때문에 원문 보존과 표시가 양립하지 않으면 해당 항목을 보류하고 알립니다.

닫힌 Issue는 종료 사실과 확인된 결과만 설명하며, 닫혔다는 사실로 성공을 추정하지 않습니다. 과거 계획과 당시 실행 상태를 현재 사실로 바꾸지 않습니다. 새 설명의 현재 상태를 확인하려면 필요한 댓글이나 PR만 추가로 읽습니다. 승인과 보류 조건이 현재도 유효한지 확인하지 못하면 그 불확실성을 바깥에 표시합니다.

적용 전 원문과 변경안을 보관하고, 변경 직전 원문을 다시 대조합니다. 본문이 바뀌었으면 그 항목을 덮어쓰지 않고 최신 내용으로 재검토합니다. 제목, 상태, 라벨, 관계와 기존 댓글은 변경하지 않습니다. 적용 후 본문을 재조회해 원문 보존과 접기 구조, 새 설명과 상세 정보의 일치 여부를 확인합니다. 완료 조건과 승인 근거를 새로 만들거나 기존 의미를 바꾸는 정리는 이 범위에 포함하지 않습니다.

### Issue 제목

모든 Issue 제목은 `[type] 한국어 제목` 형식을 사용한다. `type`은 아래 8개 중 하나를 소문자로 정확히 하나만 선택하며, 그 밖의 type은 사용하지 않는다. Issue의 주된 완료 결과를 기준으로 고른다. 작업 역할·task·execution·추적 대상·진행 방식은 제목 type을 추가하거나 대체하지 않는다.

| type       | 주된 완료 결과                                |
| ---------- | --------------------------------------------- |
| `feat`     | 새 기능을 제공한다                            |
| `fix`      | 결함을 수정한다                               |
| `refactor` | 동작을 보존하며 구조·명명·가독성을 개선한다   |
| `docs`     | 문서를 작성·수정하거나 확정된 결정을 반영한다 |
| `test`     | 테스트를 추가·보강하거나 동작·계약을 검증한다 |
| `chore`    | 설정·의존성·운영·유지보수를 처리한다          |
| `design`   | 설계·규칙·정책을 제안하거나 결정한다          |
| `research` | 기술을 조사·비교하고 근거를 수집한다          |

여러 결과가 겹치면 완료 조건에서 가장 중요한 결과 하나를 선택하며, 부모 Issue도 전체 목표를 기준으로 고른다. 새 설계·정책을 결정하는 것이 목적이면 `design`, 확정된 결정을 문서에 반영하는 것이 목적이면 `docs`를 선택한다. 제목의 type은 주된 완료 결과를 요약하며, 본문에 기록하는 작업 type·승인 상태·실행 조건을 대신하지 않는다. 제안·진행 현황과 `Desktop` 같은 접두어 안의 기술 대상 등 필요한 의미는 제목 본문에 보존한다. 이 기준은 사용자의 명시적 승인 후 활성화됐다.

```yaml
status: active
enforcement: warning
rationale: Issue 제목의 분류와 검색 기준을 통일해 주된 완료 결과를 빠르게 식별한다.
evidence: "https://github.com/blahaj94/ldb/pull/191#issuecomment-5589200367"
exceptions: "없음. 기술 식별자·고유명사는 제목 본문에서 원문을 유지할 수 있다."
review-after: "5개 Issue에 적용한 뒤 분류 모호성과 누락을 검토한다."
```

### Design / RFC Issue

새 목표의 논의와 기존 설계 기록 전환은 [`기존 기록의 전환`](task-planning.md#기존-기록의-전환)의 승인 후 적용한다. Rule 변경안 작성처럼 실행할 설계 작업은 여전히 Issue와 Draft PR로 관리한다.

Workflow, Rule, architecture의 대안, trade-off, open question, decision history를 기록한다. 재사용 가치가 있는 Proposal Revision, Decision, Rejected Alternative만 comment로 남기고 모든 reasoning step을 복사하지 않는다.

설계안 작성 자체를 Worker에게 배정하려면 아래 Execution contract의 범위·acceptance criteria·실행 조건을 갖춘 bounded Design task로 구체화한다. 설계 완료와 Rule 승인·구현 허용은 별개다.

### 부모 추적 Issue

새 목표의 기본 추적 위치는 승인된 [`Project 기준`](task-planning.md#project의-크기와-범위)을 따른다. 기존 부모 추적 Issue는 원래 기록과 남은 책임을 보존한다.

여러 자식 작업의 결과와 dependency를 추적한다. 제목의 type이 `feat`, `design` 등 무엇이든 부모 전체를 Worker에게 배정하지 않는다. 부모·자식 관계는 실행 순서를 뜻하지 않으며 선행 dependency를 별도로 확인한다. 부모의 완료는 등록된 자식 수가 아니라 부모 자체의 acceptance criteria로 판단한다.

### Execution Issue

원래 사용자 대화 없이 실행할 수 있는 하나의 bounded outcome을 다루며 최소한 다음 정보를 포함한다.

- Goal과 user-visible behavior
- Test 가능한 acceptance criteria
- In scope와 out of scope
- 관련 Rule과 context pointer. 승인된 Project 흐름으로 착수한 작업은 원래 Project와 내부 작업, 관련 Discussion 결정 및 사용자 실행 지시의 범위도 연결한다. 내부 대화 ID나 원문은 게시하지 않는다.
- Complexity, uncertainty, risk: `low | medium | high`
- Worker model tier: `low | standard | high`
- `worker_count`: 현재 배정 계획의 Worker roster slot 수인 양의 정수
- Scout 필요 여부와 조사 범위
- Validation command와 manual evidence
- Dependency: `Blocked by #123`, `Blocks #456` 형식
- Escalation condition

`worker_count`는 같은 bounded outcome의 현재 계획에 포함된 Worker scope 수다. 모든 Worker가 동시에 실행된다는 뜻이 아니며 조정만 맡은 Planner, read-only Scout·Reviewer, 실행 전담 Runner와 실행 attempt 누계를 세지 않는다. 단독 직접 수행 parent는 Worker slot 1개로 센다. 통합만 수행하는 담당도 세지 않지만 메인이 아닌 통합 담당이 code·Rule 수정 scope를 정식 배정받으면 Worker로 세고 roster에 기록한다. 완료된 scope도 Issue가 끝나거나 계획을 명시적으로 갱신할 때까지 현재 roster에 남는다. 재배정은 같은 slot의 공개 식별자를 바꾸므로 retry 자체로 count를 늘리지 않는다.

현재 실행 contract와 metadata의 source of truth는 Issue body다. Goal·AC·scope·constraint와 현재 작업 유형·상태·실행 조건, 담당 Planner, 통합 담당과 Worker roster를 한 곳에 모으고 승인·선행 결과·검증은 정확한 comment·PR·commit pointer로 연결한다. 결정이나 조건이 바뀌면 body를 갱신하고 과거 상태와 결정 근거는 comment 이력으로 남긴다. Label은 실제 automation trigger 또는 Issue 단위 `in process`·`done` 상태에만 사용한다. `Ready`·`Blocked`는 body의 실행 조건값이며 배정 상태나 Rule 승인 evidence가 아니다.

Issue는 현재 실행 조건을, PR은 실제 변경과 AC별 evidence를 전달한다. PR에 Issue contract·preflight·roster를 그대로 복사하지 않고 관련 pointer와 실제 차이·결과를 기록한다. 원문 Rule을 Issue나 PR에 복제하지 않으며 승인·검증 의무는 [`change-control.md`](change-control.md)와 [`testing.md`](testing.md)를 따른다.

전체 목표나 독립적인 완료 기준이 다르면 별도 Issue로 나눈다. 같은 bounded outcome 안에서 독립된 부분만 여러 Worker scope로 나눌 수 있다. 구체적인 독립성·dependency·충돌 판단과 roster 형식은 [`agent-execution.md`](agent-execution.md)를 따른다.

## Planning과 model tier

- 단순히 여러 의견을 얻거나 같은 구현을 경주시키려고 중복 배정하지 않는다.
- Uncertainty가 높으면 좁은 질문과 종료 조건을 가진 low-tier Scout 한 명을 먼저 검토한다.
- `low` tier는 repository 탐색, code를 변경하지 않는 반복 작업과 first-pass review에 사용한다. 단순하더라도 code 작성·수정은 배정하지 않는다.
- `standard` tier는 명확한 acceptance criteria가 있는 일반 implementation과 test의 기본값이며, code 작업은 아래 runtime mapping을 따른다.
- `high` tier는 큰 작업 planning, architecture/security ambiguity, high-risk final review와 escalation에 사용한다.
- Provider 또는 model 이름은 Issue마다 반복해 고정하지 않는다. 실행 환경은 승인된 runtime mapping으로 capability tier를 실제 model에 매핑한다.

실행 전담 Runner는 [`agent-runner.md`](agent-runner.md)의 고정 command 실행·monitor·사실 보고만 맡는 검증 보조 역할이다. 구현·조사·판정 설계는 parent의 허용된 직접 scope 또는 판단 Worker가 맡는다. Runner의 기록과 count 경계는 [`실행 보조 기록`](agent-execution.md#실행-보조-기록)을 따른다.

### Code Worker runtime mapping

- Code 작성·수정에는 implementation, bug fix, refactor, test, script와 tooling code가 모두 포함된다.
- Code를 직접 수행하는 parent도 이 mapping과 실제 model·effort 확인 의무를 따른다.
- Code Worker의 기본 실행 설정은 `gpt-6-astra`, reasoning effort `medium`이다. `standard` tier의 일반 implementation은 이 설정에 매핑하며, 작업이 단순하다는 이유로 `low` tier나 더 낮은 effort에 배정하지 않는다.
- `gpt-5.3-codex-spark`, reasoning effort `high`는 승인된 Rule 또는 합의된 acceptance criteria에서 입력·기대 결과·검증 방식이 확정되고 기존 pattern으로 작성 가능한 bounded test와 fixture에 사용할 수 있다. Unit test와 parameterized test가 그 예이며, `test`라는 이름이나 `.py`·`.mjs` 확장자만으로 예외를 적용하지 않는다.
- Spark High는 승인된 Rule 또는 합의된 acceptance criteria에서 입력·기대 결과·검증 방식이 확정되고 기존 pattern으로 작성 가능하며, 중요한 state를 바꾸지 않는 작은 `.py`·`.mjs` 보조 script에도 사용할 수 있다. 범위는 local file 읽기, JSON·CSV 변환, file 목록 검사와 결과 집계 등이며, 적용 근거는 Issue의 기존 context pointer와 validation command로 확인한다.
- 일반 code, bug fix와 refactor, test 의미·경계 조건 설계, 인증·동시성·transaction·복잡한 integration harness에는 GPT-6 Astra Medium을 유지한다. 배포·database 변경·data 삭제 등 중요한 state를 바꾸는 script도 Spark 예외에서 제외한다.
- Spark 작업도 [`testing.md`](testing.md)의 Red-Green과 test integrity를 따른다. 기대값은 승인된 Rule 또는 합의된 acceptance criteria에서 가져오며, assertion·validation을 약화하거나 test를 통과시키려고 제품 code를 수정하지 않는다.
- Spark 작업에서 승인된 Rule 또는 합의된 acceptance criteria에 없는 기대값·설계 판단이나 scope 확대가 필요하면 실행을 중단하고 GPT-6 Astra Medium 전환 또는 아래 escalation 절차를 따른다. 예상하지 못한 실패에는 기존 최대 1회 retry를 적용하며 반복 실패 시 같은 절차를 따른다. 기대한 Red 실패는 작업 실패나 retry budget 소진으로 계산하지 않는다.
- 실행 환경이 같은 Worker의 model 설정 변경을 지원하면 GPT-6 Astra Medium으로 재개한다. 새 Worker가 필요하면 기존 Worker의 중단 확인·인계·재배정 절차를 따르고 retry budget을 그대로 이관한다.
- 사용자가 model 또는 effort를 명시하면 그 선택을 우선한다. 다른 model이나 더 높은 effort는 사용자의 명시적 선택 또는 승인된 runtime mapping에 따라 사용할 수 있지만, `gpt-6-astra`와 `medium` 요청을 자동으로 낮추지 않는다.
- Planner와 Worker는 착수 전에 실제 model과 effort가 선택되었는지 확인한다. 선택한 설정을 사용할 수 없거나 확인할 수 없으면 조용히 다른 model이나 effort로 바꾸지 않고 가용성 문제를 알리며, 확인하지 못한 설정을 적용했다고 보고하지 않는다.
- 이 mapping은 Issue의 capability tier metadata를 대체하지 않으며 Issue마다 provider/model 이름을 반복해 고정하지 않는다. Model 선택과 관계없이 [`../../convention.md`](../../convention.md), [`testing.md`](testing.md), 이 문서의 review·escalation 기준을 모두 적용한다.

#### Convention migration proposal

`docs/rules/convention-migration.md`의 동작 보존 이행에 한해, 결과·범위·검증이 확정되고 uncertainty·risk가 `low`인 standard capability tier 코드 작성 작업을 `gpt-5.6-luna`, reasoning effort `low`로 실행한다. 이는 capability tier를 low로 바꾸는 것이 아니라 standard tier 작업의 실제 model 비용을 낮추는 mapping이다. 따라서 low tier 전체의 코드 작성 금지와 충돌하지 않는다.

```yaml
status: active
enforcement: approval-required
rationale: 동작 보존 이행을 작은 단위와 확인 가능한 비용 경계로 진행한다.
evidence: "https://github.com/blahaj94/ldb/pull/150#issuecomment-5580132558"
exceptions: 사용자 선택 우선, 실제 설정 확인·가용성 보류, 사람 판단과 사용자 merge 전 제품 code 이행 금지는 이 문서와 convention migration Rule의 해당 절을 따른다.
review-after: 시범 PR 2~3개를 사용자 merge한 뒤 usage·재작업·검토 부담을 확인한다.
```

이 예외는 해당 Rule이 사용자 승인·merge된 뒤에만 기존 Astra/Spark 일반 규칙에 우선해 실행 근거가 된다. 경계 판단·새 의미·범위 확장이 필요하면 적용하지 않는다. 착수 전에 실제 model과 effort를 확인하며, 확인 불가 시 자동 상향이나 effort 증가는 하지 않고 작업을 분할하거나 사람의 판단으로 넘긴다. 기존 최대 1회 retry 한도와 escalation을 유지하며 조사·구현·1차 검토에 고비용 model을 자동 배정하지 않는다. 단, code Reviewer에는 [Code review model proposal](#code-review-model-proposal)의 고정 mapping을 우선 적용한다. Rule·security의 최종 review는 사람 경로를 따른다.

기존 escalation의 고위험·Rule·architecture·security·API·schema·authentication, P0/P1 finding, 검증 불완전 조건은 그대로 적용하며 필수 최종 review를 생략하지 않는다. 이번 이행에서 해당 조건이 발생하면 자동으로 model이나 effort를 상향하지 않고 사람에게 최종 검토를 요청한다. 예상 밖 실패, 범위 초과, 검증 불가, retry 소진에도 같은 원칙을 적용한다. 후속 분할·배정·통합 조정에도 고비용 model을 자동 배정하지 않으며, 반복 구현을 이유로 별도 고비용 Planner를 만들지 않는다. 사용자가 model 또는 effort를 명시한 경우에는 기존 조항에 따라 그 선택을 우선한다.

## 실행 효율 계약의 재검토

```yaml
status: active
enforcement: approval-required
rationale: 작은 작업의 위임·인계·검토와 command 실행·monitor·중복 검증 비용을 줄이면서 승인과 evidence 책임을 유지한다.
evidence: "Issue #105, PR #106 사용자 승인: https://github.com/blahaj94/ldb/pull/106#issuecomment-5561177716"
exceptions: 직접 수행 조건이나 고정된 실행 입력이 충족되지 않으면 기존 역할 분리와 escalation을 유지한다.
review-after: canonical 반영 후 실제 Execution Issue 3개에서 직접 수행·실행 전담·PASS 재사용 사례와 누락을 검토한다. 사례가 없던 항목은 검증됐다고 간주하지 않는다.
```

수행 모드 선택 이유, 위임·인계·review 추가 작업, 중복 command 생략, 재실행 이유, evidence 누락과 총사용량 snapshot을 검토한다. 기존 시각·사용량 기록만 활용하며 정밀 timing을 위한 새 wrapper·rerun은 하지 않는다. 누락·소유권 충돌·잘못된 PASS 채택이 있으면 해당 예외의 확대를 멈추고 수정 또는 폐기를 제안한다. 관측하지 못한 사례나 절감량은 추정하지 않는다.

공통 routing 판단·소유권·evidence 계약은 canonical Rule에서 관리한다. 향후 skill은 역할 선택과 필요한 Rule pointer만, custom-agent TOML은 model·effort·역할 제한 등 실행 설정만 담는 얇은 adapter로 둔다. 원문 지침을 여러 파일에 복제하지 않는다. 이 계약은 Luna Xhigh나 Astra Low를 새 mapping으로 확정하지 않는다. Model 변경 실험은 별도 bounded 제안·승인·실제 실행 evidence가 필요하다. 실제 adapter 설치나 제품 구현 착수는 이 계약의 승인과 구분하고 후속 Issue에서 scope·실행 조건을 확인한다.

Runtime이 요구한 custom role·model·effort를 지원하지 않거나 확인할 수 없으면 적용했다고 주장하거나 조용히 다른 model로 바꾸지 않는다. 가용성 문제를 알리고 기존 승인 설정의 허용된 owner가 실행하거나 새 선택을 요청한다.

## Escalation

다음 조건에서는 작업을 중단하고 Planner 또는 사람에게 escalation한다.

- Scope expansion 또는 acceptance criteria 충돌
- Rule, architecture, public API, database schema 변경 필요
- Security ambiguity
- Dependency 또는 필요한 context 부재
- 관련 validation 실행 불가
- Configured retry budget 소진

Risk가 `high`이거나 Rule, architecture, API, schema, authentication, authorization을 변경하거나 first-pass review의 P0/P1 finding이 남거나 validation evidence가 불완전하면 high-capability final review 또는 사람 review가 필요하다.
