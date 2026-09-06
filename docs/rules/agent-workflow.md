---
type: rule
status: active
enforcement: approval-required
scope: repository
last-reviewed: 2026-09-06
rationale: 작은 GitHub Issue의 책임과 Worker 배정·완료를 명확히 하여 중복 착수와 agent 사이의 context·비용을 제한한다.
evidence: "GitHub Issue #26, #44, #79, #81"
exceptions: 긴급 작업도 change-control approval boundary와 사용자 merge 권한은 생략하지 않는다.
review-after: Execution Issue 10개 적용 후
---

# Agent Workflow

## 목적

큰 개발 요청을 Planner, Worker, Reviewer가 원래 대화 없이 이어받을 수 있는 작은 task로 바꾼다. GitHub Issue와 Pull Request가 durable coordination artifact이며 conversation history는 source of truth가 아니다.

이 문서는 역할, Issue contract와 model tier를 정의한다. 배정·상태·handoff·통합 계약은 [`agent-execution.md`](agent-execution.md), approval·branch·worktree·commit·merge 절차는 [`change-control.md`](change-control.md), test evidence는 [`testing.md`](testing.md), context와 logic budget은 [`code-quality.md`](code-quality.md)를 따른다.

## 역할과 단일 책임

### Planner

- 사용자가 지정한 repository 전체의 활성 Planner 한 명이 Issue contract, 배정, 상태 전이와 결과 검토를 순서대로 관리한다. 대화나 terminal마다 별도 Planner를 자동으로 두지 않는다.
- 여러 독립 결과나 architecture 판단이 필요한 큰 요청만 분해한다. 이미 bounded한 요청에는 별도 planning 단계를 만들지 않는다.
- 메인 context에는 오래 유지할 요구, 확정된 결정, 배정, dependency와 결과 evidence를 둔다. Code 탐색·구현·test의 상세 context는 Worker에게 맡긴다.
- 메인 세션의 Planner는 Worker 역할을 겸하지 않는다. 직접 code 탐색·구현·test를 수행하거나 같은 탐색과 raw log 재검토로 대기를 채우지 않고 상세 작업은 별도 Worker context에 둔다.
- High-capability model은 큰 작업의 decomposition, architecture, security, 높은 uncertainty 판단에 사용한다.

### Worker

- 하나의 bounded scope만 수행하고 필요한 context를 점진적으로 읽는다. 같은 Issue 안에서도 배정되지 않은 다른 Worker 범위를 맡지 않는다.
- Issue 범위, approval boundary, dependency와 최신 roster를 확인한 뒤 자신의 branch와 worktree에서 작업한다.
- Acceptance criteria를 validation evidence로 검증하고 commit과 짧은 결과를 통합 담당에게 반환한다.
- Scope를 임의로 늘리거나 architecture ambiguity를 추측으로 해결하지 않는다.

### 통합 담당

- Issue마다 한 명을 지정한다. Issue 통합 branch와 결과 채택 순서, 충돌 처리, 최종 head validation을 책임진다.
- Worker의 상세 탐색을 다시 수행하지 않고 bounded result, diff와 validation evidence를 검토한다.
- Semantic conflict나 누락을 직접 구현해 메우지 않고 관련 Worker에게 같은 범위의 후속 작업으로 돌려보낸다. 메인이 아닌 통합 담당이 수정까지 맡아야 하면 별도 bounded Worker scope로 정식 배정하고 roster에 기록한다.
- Planner가 통합 담당을 겸할 수 있지만 branch 조정·결과 검토·validation만 맡고 상세 code 탐색·구현·test는 Worker context에 둔다. 배정·승인·완료 기록의 단일 책임도 유지한다.

### Reviewer

- Issue acceptance criteria, 통합된 diff, validation result와 concise Worker summary를 기준으로 consequential defect를 찾는다.
- Worker conversation, 전체 reasoning과 shell history를 요구하지 않는다.
- Low-cost first-pass review를 기본으로 하고 escalation 조건에 해당할 때만 high-capability reviewer 또는 사람에게 넘긴다.
- Agent Reviewer는 사용자 승인과 merge를 수행하지 않는다.

## Issue 종류

### Design / RFC Issue

Workflow, Rule, architecture의 대안, trade-off, open question, decision history를 기록한다. 재사용 가치가 있는 Proposal Revision, Decision, Rejected Alternative만 comment로 남기고 모든 reasoning step을 복사하지 않는다.

설계안 작성 자체를 Worker에게 배정하려면 아래 Execution contract의 범위·acceptance criteria·실행 조건을 갖춘 bounded Design task로 구체화한다. 설계 완료와 Rule 승인·구현 허용은 별개다.

### 부모 추적 Issue

여러 자식 작업의 결과와 dependency를 추적한다. 제목이 Execution이어도 부모 전체를 Worker에게 배정하지 않는다. 부모·자식 관계는 실행 순서를 뜻하지 않으며 선행 dependency를 별도로 확인한다. 부모의 완료는 등록된 자식 수가 아니라 부모 자체의 acceptance criteria로 판단한다.

### Execution Issue

원래 사용자 대화 없이 실행할 수 있는 하나의 bounded outcome을 다루며 최소한 다음 정보를 포함한다.

- Goal과 user-visible behavior
- Test 가능한 acceptance criteria
- In scope와 out of scope
- 관련 Rule과 context pointer
- Complexity, uncertainty, risk: `low | medium | high`
- Worker model tier: `low | standard | high`
- `worker_count`: 현재 배정 계획의 Worker roster slot 수인 양의 정수
- Scout 필요 여부와 조사 범위
- Validation command와 manual evidence
- Dependency: `Blocked by #123`, `Blocks #456` 형식
- Escalation condition

`worker_count`는 같은 bounded outcome의 현재 계획에 포함된 Worker scope 수다. 모든 Worker가 동시에 실행된다는 뜻이 아니며 Planner, read-only Scout·Reviewer와 실행 attempt 누계를 세지 않는다. 통합만 수행하는 담당도 세지 않지만 메인이 아닌 통합 담당이 code·Rule 수정 scope를 정식 배정받으면 Worker로 세고 roster에 기록한다. 완료된 scope도 Issue가 끝나거나 계획을 명시적으로 갱신할 때까지 현재 roster에 남는다. 재배정은 같은 slot의 공개 식별자를 바꾸므로 retry 자체로 count를 늘리지 않는다.

Metadata의 source of truth는 Issue body다. 현재 작업 유형·상태·실행 조건, 담당 Planner, 통합 담당과 Worker roster를 한 곳에 모으고 과거 상태는 comment 이력으로 남긴다. Label은 실제 automation trigger 또는 Issue 단위 `in process`·`done` 상태에만 사용한다. `Ready`·`Blocked`는 body의 실행 조건값이며 배정 상태나 Rule 승인 evidence가 아니다.

전체 목표나 독립적인 완료 기준이 다르면 별도 Issue로 나눈다. 같은 bounded outcome 안에서 독립된 부분만 여러 Worker scope로 나눌 수 있다. 구체적인 독립성·dependency·충돌 판단과 roster 형식은 [`agent-execution.md`](agent-execution.md)를 따른다.

## Planning과 model tier

- 단순히 여러 의견을 얻거나 같은 구현을 경주시키려고 중복 배정하지 않는다.
- Uncertainty가 높으면 좁은 질문과 종료 조건을 가진 low-tier Scout 한 명을 먼저 검토한다.
- `low` tier는 repository 탐색, code를 변경하지 않는 반복 작업과 first-pass review에 사용한다. 단순하더라도 code 작성·수정은 배정하지 않는다.
- `standard` tier는 명확한 acceptance criteria가 있는 일반 implementation과 test의 기본값이며, code 작업은 아래 runtime mapping을 따른다.
- `high` tier는 큰 작업 planning, architecture/security ambiguity, high-risk final review와 escalation에 사용한다.
- Provider 또는 model 이름은 Issue마다 반복해 고정하지 않는다. 실행 환경은 승인된 runtime mapping으로 capability tier를 실제 model에 매핑한다.

### Code Worker runtime mapping

- Code 작성·수정에는 implementation, bug fix, refactor, test, script와 tooling code가 모두 포함된다.
- Code Worker의 기본 실행 설정은 `gpt-5.6-sol`, reasoning effort `high`다. `standard` tier의 일반 implementation은 이 설정에 매핑하며, 작업이 단순하다는 이유로 `low` tier나 더 낮은 effort에 배정하지 않는다.
- `gpt-5.3-codex-spark`, reasoning effort `high`는 승인된 Rule 또는 합의된 acceptance criteria에서 입력·기대 결과·검증 방식이 확정되고 기존 pattern으로 작성 가능한 bounded test와 fixture에 사용할 수 있다. Unit test와 parameterized test가 그 예이며, `test`라는 이름이나 `.py`·`.mjs` 확장자만으로 예외를 적용하지 않는다.
- Spark High는 승인된 Rule 또는 합의된 acceptance criteria에서 입력·기대 결과·검증 방식이 확정되고 기존 pattern으로 작성 가능하며, 중요한 state를 바꾸지 않는 작은 `.py`·`.mjs` 보조 script에도 사용할 수 있다. 범위는 local file 읽기, JSON·CSV 변환, file 목록 검사와 결과 집계 등이며, 적용 근거는 Issue의 기존 context pointer와 validation command로 확인한다.
- 일반 code, bug fix와 refactor, test 의미·경계 조건 설계, 인증·동시성·transaction·복잡한 integration harness에는 Sol High를 유지한다. 배포·database 변경·data 삭제 등 중요한 state를 바꾸는 script도 Spark 예외에서 제외한다.
- Spark 작업도 [`testing.md`](testing.md)의 Red-Green과 test integrity를 따른다. 기대값은 승인된 Rule 또는 합의된 acceptance criteria에서 가져오며, assertion·validation을 약화하거나 test를 통과시키려고 제품 code를 수정하지 않는다.
- Spark 작업에서 승인된 Rule 또는 합의된 acceptance criteria에 없는 기대값·설계 판단이나 scope 확대가 필요하면 실행을 중단하고 Sol High 전환 또는 아래 escalation 절차를 따른다. 예상하지 못한 실패에는 기존 최대 1회 retry를 적용하며 반복 실패 시 같은 절차를 따른다. 기대한 Red 실패는 작업 실패나 retry budget 소진으로 계산하지 않는다.
- 실행 환경이 같은 Worker의 model 설정 변경을 지원하면 Sol High로 재개한다. 새 Worker가 필요하면 기존 Worker의 중단 확인·인계·재배정 절차를 따르고 retry budget을 그대로 이관한다.
- 사용자가 model 또는 effort를 명시하면 그 선택을 우선한다. 다른 model이나 더 높은 effort는 사용자의 명시적 선택 또는 승인된 runtime mapping에 따라 사용할 수 있지만, `gpt-5.6-sol`과 `high` 요청을 자동으로 낮추지 않는다.
- Planner와 Worker는 착수 전에 실제 model과 effort가 선택되었는지 확인한다. 선택한 설정을 사용할 수 없거나 확인할 수 없으면 조용히 다른 model이나 effort로 바꾸지 않고 가용성 문제를 알리며, 확인하지 못한 설정을 적용했다고 보고하지 않는다.
- 이 mapping은 Issue의 capability tier metadata를 대체하지 않으며 Issue마다 provider/model 이름을 반복해 고정하지 않는다. Model 선택과 관계없이 [`../../convention.md`](../../convention.md), [`testing.md`](testing.md), 이 문서의 review·escalation 기준을 모두 적용한다.

## Escalation

다음 조건에서는 작업을 중단하고 Planner 또는 사람에게 escalation한다.

- Scope expansion 또는 acceptance criteria 충돌
- Rule, architecture, public API, database schema 변경 필요
- Security ambiguity
- Dependency 또는 필요한 context 부재
- 관련 validation 실행 불가
- Configured retry budget 소진

Risk가 `high`이거나 Rule, architecture, API, schema, authentication, authorization을 변경하거나 first-pass review의 P0/P1 finding이 남거나 validation evidence가 불완전하면 high-capability final review 또는 사람 review가 필요하다.
