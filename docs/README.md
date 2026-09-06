---
type: rule
status: active
enforcement: approval-required
scope: repository
last-reviewed: 2026-09-06
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

| 작업                             | Required document                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| 모든 code 작성·수정·review       | [`convention.md`](../convention.md), `docs/rules/change-control.md`, `docs/rules/testing.md`, `docs/rules/code-quality.md` |
| Web·Desktop UI의 시각 기준·공용 자산 | [`rules/design-system.md`](rules/design-system.md) |
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
- 본문은 한국어, technical term은 English로 작성한다.
- secret, token, credential, 개인정보를 기록하지 않는다.
- Obsidian은 논의와 기록을 위한 공간이며 repository document를 대체하지 않는다.

## Index

### Rule

- [`convention.md`](../convention.md): 프로젝트 전체 코드의 의미별 검사·boolean 합성·오류 책임과 가독성 기준
- [`rules/change-control.md`](rules/change-control.md): approval, Issue, branch, commit, PR, parallel 작업
- [`rules/testing.md`](rules/testing.md): Red-Green workflow와 validation 기준
- [`rules/code-quality.md`](rules/code-quality.md): logic budget과 유지보수성 기준
- [`rules/design-system.md`](rules/design-system.md): 공통 자산·용도별 기본값·Layout·밀도와 화면별 외형 override 금지
- [`rules/backend-readability.md`](rules/backend-readability.md): 기존 Backend 가독성 Rule 경로, 공통 `convention.md`로 이전
- [`rules/agent-workflow.md`](rules/agent-workflow.md): Planner, Worker, Reviewer의 GitHub handoff contract
- [`rules/agent-execution.md`](rules/agent-execution.md): 복수 Worker의 roster, context, 상태와 통합 계약
- [`architecture/overview.md`](architecture/overview.md): 현재 system boundary와 architecture approval 지점

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
