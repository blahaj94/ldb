---
type: rule
status: active
enforcement: approval-required
scope: repository
last-reviewed: 2026-09-07
---

# LDB Document Guide

이 directory는 AI agent가 작은 context로 안전하게 작업하기 위한 canonical project knowledge를 관리한다. 대화 transcript나 일시적인 task backlog는 저장하지 않는다.

## Document class

### Rule document

Code가 따라야 하는 결정과 agent의 행동 경계를 정의한다. 다음 위치가 해당한다.

- `AGENTS.md`
- Root [`convention.md`](../convention.md)
- `docs/rules/**`
- `docs/architecture/**`
- 향후 생성되는 domain rule

AI는 변경을 제안하고 Draft PR에 commit할 수 있지만, 사용자의 명시적인 승인 전에는 Rule을 전제로 한 구현을 진행할 수 없다. Rule document와 실제 implementation이 충돌하면 AI가 어느 한쪽을 임의로 선택하지 않고 사용자에게 질문한다.

### Reference document

현재 code, config, command, file 구조를 설명한다. `docs/reference/**`가 해당하며 AI가 실제 repository와 일치하도록 자율적으로 갱신한다. 충돌하면 실행되는 code, config, test를 기준으로 Reference document를 수정한다.

## Reading route

아래 역할별 시작점과 연결된 읽기·출력·인계·기록 기준은 [PR #99의 사용자 승인](https://github.com/blahaj94/ldb/pull/99#issuecomment-5559860989)과 merge를 반영한 active Rule이다. 기존 active Rule의 승인 상태와 의무는 유지하며, 이후 변경의 승인은 [`change-control.md`](rules/change-control.md#approval-evidence)를 따른다.

```yaml
status: active
enforcement: approval-required
rationale: 역할에 필요한 context부터 확인하고 재독·출력·인계·기록의 중복 비용을 줄인다.
evidence: "https://github.com/blahaj94/ldb/pull/99#issuecomment-5559860989"
exceptions: 적용되는 Rule·AC·승인·보안·검증 의무는 생략하지 않고 불확실하면 관련 본문을 확인한다.
review-after: 승인 후 서로 다른 역할의 Execution Issue 3개에서 누락과 재독·인계 비용을 확인한다.
```

### 역할별 시작점

현재 Issue contract를 확인한 뒤 아래 문서·절에서 시작한다. 이어서 작업 topic과 path에 적용되는 Rule 본문을 확인한다. 시작점은 읽기의 순서이며 적용되는 의무의 상한이 아니다. 동일 revision의 재확인 조건은 [`AGENTS.md`](../AGENTS.md#context), 조회 범위와 출력 제한은 [`Context budget`](rules/code-quality.md#context-budget)을 따른다.

| 역할·작업 | 시작 문서·절 |
| --- | --- |
| Planner | [`agent-workflow.md`](rules/agent-workflow.md)의 역할과 단일 책임·Execution Issue·Planning과 model tier·Escalation, [`change-control.md`](rules/change-control.md)의 Approval required·Approval evidence·Issue and preflight. 배정할 때 [`agent-execution.md`](rules/agent-execution.md)의 Worker roster와 상태·배정 절차·병렬 가능성·Handoff와 context |
| 단독 직접 수행 parent | [`agent-workflow.md`의 수행 모드 선택](rules/agent-workflow.md#수행-모드-선택)과 [Code Worker runtime mapping](rules/agent-workflow.md#code-worker-runtime-mapping), [`agent-execution.md`의 수행 모드와 소유권](rules/agent-execution.md#수행-모드와-소유권). 이어서 아래 Code Worker 또는 Code 없는 문서 작업 route의 해당 의무 확인 |
| 실행 전담 Runner | 현재 실행 packet과 [`agent-runner.md`](rules/agent-runner.md)의 범위와 권한·실행 packet·실행·대기·취소·재시도·고정 결과 형식, [`agent-execution.md`의 실행 보조 기록](rules/agent-execution.md#실행-보조-기록). 판단 owner는 [`testing.md`의 검증 evidence 재사용](rules/testing.md#검증-evidence-재사용) 확인 |
| Code Worker | [`agent-workflow.md`](rules/agent-workflow.md)의 [Worker](rules/agent-workflow.md#worker)·[Code Worker runtime mapping](rules/agent-workflow.md#code-worker-runtime-mapping)·[Escalation](rules/agent-workflow.md#escalation), [`convention.md`](../convention.md#읽기-안내)의 적용 범위·규칙 본문, [`change-control.md`](rules/change-control.md)의 Approval required·Approval evidence·Issue and preflight·Branch, worktree, and parallel work·Commit and PR order, [`testing.md`](rules/testing.md)의 Red-Green workflow·Required evidence·Test integrity·Validation, [`code-quality.md`](rules/code-quality.md)의 Logic budget·Maintainability·Context budget. 배정·인계에는 [`agent-execution.md`](rules/agent-execution.md)의 해당 절 |
| Code 없는 문서 작업 | 이 문서의 Document class·Document maintenance, [`change-control.md`](rules/change-control.md)의 승인·preflight·branch·commit·PR 절, 변경 대상의 Rule 본문과 [`code-quality.md`](rules/code-quality.md)의 Context budget. Rule 변경안을 작성할 때 [Experimental Rule lifecycle](rules/code-quality.md#experimental-rule-lifecycle) 확인. `convention.md` 전문은 필요하지 않으며 code 예시를 수정하면 해당 작성 기준 확인 |
| Read-only Reviewer | Issue AC·통합 diff·validation evidence·짧은 Worker summary와 diff에 적용되는 Rule 본문, [`agent-workflow.md`](rules/agent-workflow.md)의 Reviewer·Escalation. Code review는 [`convention.md`](../convention.md#review에서-확인할-것)의 checklist에서 해당 규칙 본문으로 확장하고 [`change-control.md`](rules/change-control.md)의 승인 기준·[`testing.md`](rules/testing.md)의 evidence·integrity·validation 기준 확인 |
| 통합 담당 | 채택할 result·base·diff·validation evidence, [`agent-execution.md`](rules/agent-execution.md)의 Branch와 통합·진행, 대기와 완료·PR handoff, [`change-control.md`](rules/change-control.md)의 Branch, worktree, and parallel work·Commit and PR order와 [`testing.md`](rules/testing.md)의 Validation |

단독 직접 수행·Runner route와 검증 재사용은 [PR #106의 사용자 승인](https://github.com/blahaj94/ldb/pull/106#issuecomment-5561177716)을 반영한다. 수행 조건은 [`수행 모드 선택`](rules/agent-workflow.md#수행-모드-선택)을, 재검토는 [`실행 효율 계약의 재검토`](rules/agent-workflow.md#실행-효율-계약의-재검토)를 따른다.

Code 작성·수정에서는 적용되는 convention 본문, approval boundary와 testing 의무를 모두 확인한다. Code 예시는 의미가 불명확하거나 해당 pattern을 다룰 때 읽으며 관련 없는 운영 절은 그 역할·작업을 맡을 때 확장한다. Read-only Reviewer가 수정을 맡으면 먼저 Worker 배정과 해당 작성 route를 따른다.

### Topic별 확장

| 작업                             | Required document                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| Code 작성·수정·review       | 위 역할별 시작점과 [`convention.md`](../convention.md#읽기-안내)에 따라 `change-control.md`, `testing.md`, `code-quality.md`의 적용 본문 확인 |
| Web·Desktop UI의 SEED 기준·공용 자산·Example·시각 검증 | [`rules/design-system.md`](rules/design-system.md); package·peer·CSS 책임은 [`Shared UI boundary`](architecture/overview.md#shared-ui-boundary) |
| 큰 작업 분해와 역할·Issue contract | `docs/rules/agent-workflow.md`                                                       |
| Worker 배정·상태·handoff·통합   | `docs/rules/agent-execution.md`                                                       |
| app 또는 package boundary 변경   | `docs/architecture/overview.md`                                                       |
| 실행 command 또는 file 위치 확인 | `docs/reference/repository-map.md`                                                    |
| API runtime·검색 작업 | `docs/rules/api-runtime.md`, `docs/rules/character-search.md` |
| 인증·session·DB 작업 | 아래 Authentication contract routing에서 관련 topic 선택. 승인된 contract와 미결정 gate·구현 착수 조건을 함께 확인 |
| 기획·domain 작업                 | 향후 `docs/product/**`, `docs/domain/**`에서 task 관련 document만 선택                |

## Document maintenance

- 같은 Rule을 여러 document에 중복 작성하지 않고 canonical file을 link한다.
- `AGENTS.md`는 약 150줄, 개별 Rule document는 약 250줄을 soft budget으로 사용한다.
- soft budget을 넘으면 정보를 삭제하지 않고 topic별로 분리하고 이 index에서 routing한다.
- Source 위치는 file path로만 기록한다. Line number는 사용하지 않는다.
- 언어와 설명 작성 기준은 [`AGENTS.md`의 작성 기준](../AGENTS.md#작성-기준)을 따른다.
- secret, token, credential, 개인정보를 기록하지 않는다.
- Obsidian은 논의와 기록을 위한 공간이며 repository document를 대체하지 않는다.

## Index

### Rule

- [`convention.md`](../convention.md): 프로젝트 전체 코드의 의미별 검사·boolean 합성·오류 책임과 가독성 기준
- [`rules/change-control.md`](rules/change-control.md): approval, Issue, branch, commit, PR, parallel 작업
- [`rules/testing.md`](rules/testing.md): Red-Green workflow와 validation 기준
- [`rules/code-quality.md`](rules/code-quality.md): logic budget과 유지보수성 기준
- [`rules/design-system.md`](rules/design-system.md): SEED 재사용·고정 source·기본값·override 금지·중립 Example·향후 검증 matrix
- [`rules/backend-readability.md`](rules/backend-readability.md): 기존 Backend 가독성 Rule 경로, 공통 `convention.md`로 이전
- [`rules/agent-workflow.md`](rules/agent-workflow.md): Planner, Worker, Reviewer의 GitHub handoff contract
- [`rules/agent-execution.md`](rules/agent-execution.md): 수행 모드, Worker roster, context, 상태와 통합 계약
- [`rules/agent-runner.md`](rules/agent-runner.md): 실행 전담의 입력·job owner·완료 evidence·취소·retry·보고 계약
- [`rules/agent-efficiency-proposal.md`](rules/agent-efficiency-proposal.md): PR #106에서 승인·canonical 반영된 제안 이력과 active Rule pointer. 별도 실행 authority 없음
- [`architecture/overview.md`](architecture/overview.md): 현재 system boundary·Shared UI boundary 제안·peer/CSS 책임과 architecture approval 지점
- [`architecture/auth-operations-proposal.md`](architecture/auth-operations-proposal.md): 인증·탈퇴의 자체 운영 배치·journal/witness·권한·보관 제안. 복원 순서·장애 대응과 미실행 matrix는 [`architecture/auth-operations-validation-proposal.md`](architecture/auth-operations-validation-proposal.md). 두 문서는 proposed이며 구현 authority 없음

- [`rules/api-runtime.md`](rules/api-runtime.md): API runtime·dependency·build/test 계약
- [`rules/character-search.md`](rules/character-search.md): 검색 query·응답·오류·계정 제한 계약

### Authentication contract routing

이 Rule은 #39 최종 설계에 대한 [PR #48 사용자 승인](https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519)을 반영한다. 승인된 contract는 현재 구현·검증 성공과 구분한다. 사용자가 미결정 gate 유지와 구현 금지를 명시했으므로 별도 착수 지시 전에는 구현·설치·DB 실행을 진행하지 않는다.

| 필요한 topic | Canonical Rule |
| --- | --- |
| Endpoint·parser·오류·nickname·log sink | [`rules/auth-api.md`](rules/auth-api.md) |
| Client/provider binding·OAuth 상태·TTL·provider 검증 | [`rules/auth-oauth.md`](rules/auth-oauth.md) |
| JWT/key·30일·refresh/logout 최종 경합 | [`rules/auth-session.md`](rules/auth-session.md) |
| 핵심 4개 테이블·constraint·잠금·정리/물리 보관·삭제 경계 | [`rules/auth-database.md`](rules/auth-database.md) |
| 검색 admission/quota·활동 commit·residual JWT·DB 장애·계정 기능 경합 | [`rules/auth-activity.md`](rules/auth-activity.md) |
| 승인된 exact dependency·Migration·운영/플랫폼 미결정 gate | [`rules/auth-runtime.md`](rules/auth-runtime.md) |
| 탈퇴 재인증·삭제 상태/권한·재가입 경합·provider revoke·보관·백업 복원 | [`rules/auth-withdrawal-proposal.md`](rules/auth-withdrawal-proposal.md) |

탈퇴 D1–D5는 [PR #72 사용자 승인](https://github.com/blahaj94/ldb/pull/72#issuecomment-5557976162)으로 확정됐다. Canonical file의 기존 path는 유지하며 active Rule로 관리한다. 정책 승인과 lifecycle/schema/API의 실제 구현·운영/복원 검증은 별개이고, 기존 login/refresh·초기 4-table 검증 AC를 소급 변경하지 않는다.

배치·저장·backup·복원 환경을 검토할 때는 [인증 운영 구성 제안](architecture/auth-operations-proposal.md)과 [복원·검증 제안](architecture/auth-operations-validation-proposal.md)을 읽는다. 승인된 D1–D5의 변경안이 아니라 운영 선택의 proposed 문서다.

### Desktop authentication contract routing

다음은 Issue #55 설계에 대한 [PR #60 사용자 승인](https://github.com/blahaj94/ldb/pull/60#issuecomment-5553807475)을 반영한다. Desktop 설계 선택은 승인됐으며 실제 지원 OS·등록값·native 검증 gate는 유지한다. 설계 승인은 제품 구현·실제 OAuth/OS 등록 또는 credential 저장소 변경의 착수 지시가 아니므로 후속 작업의 범위와 실행 조건을 별도로 확인한다.

| 필요한 topic | Canonical Rule |
| --- | --- |
| Process 책임·기존 capture 연결·최소 IPC·화면 | [`rules/desktop-auth.md`](rules/desktop-auth.md) |
| Pending/PKCE·브라우저→exchange·refresh·취소/실패·재시작 | [`rules/desktop-auth-lifecycle.md`](rules/desktop-auth-lifecycle.md) |
| 실제 환경 근거·safeStorage/파일·protocol·미검증 matrix/등록 gate | [`rules/desktop-auth-platform.md`](rules/desktop-auth-platform.md) |
| 탈퇴 전용 main receipt·상태 조회·local auth 정리·재시작 연결 | [`rules/auth-withdrawal-proposal.md`](rules/auth-withdrawal-proposal.md) |

탈퇴의 Desktop 확장은 PR #72에서 승인됐으며 기존 login pending·polling 없음과 구분한다. 구체적 IPC/화면·OS 구현과 실제 환경 검증은 별도 후속 범위다.

### Reference

- [`reference/repository-map.md`](reference/repository-map.md): workspace, app, command 현황
