---
type: rule
status: active
enforcement: approval-required
scope: architecture
last-reviewed: 2026-09-06
---

# Architecture Overview

## Repository topology

LDB는 pnpm workspace monorepo다.

```text
apps/
  api/
  web/
  desktop/
packages/
scripts/
```

- `apps/api`: NestJS API workspace. 승인된 ESM runtime·dependency·build/test 계약은 [`../rules/api-runtime.md`](../rules/api-runtime.md)를 따른다. 구현 현황은 Reference에서 확인한다.
- `apps/web`: React, TypeScript, Vite 기반 web application.
- `apps/desktop`: Electron, React, TypeScript, electron-vite 기반 desktop application.
- `packages/*`: shared package를 위한 예약 boundary. 현재 tracked package는 없다.
- `scripts`: repository 생성·관리 script.

상세한 file과 command 현황은 [`../reference/repository-map.md`](../reference/repository-map.md)를 따른다.

## Approved boundary

현재 workspace·app boundary와 API runtime·검증 기반이 승인됐다. 검색의 입력·응답·오류·계정 제한은 [`../rules/character-search.md`](../rules/character-search.md)를 따른다. 근거는 [PR #42 사용자 승인](https://github.com/blahaj94/ldb/pull/42#issuecomment-5550598698)이다. 인증·핵심 DB·서버 통신의 추가 승인 범위는 아래 Authentication boundary contract를 따른다.

PostgreSQL server·image·local validation 선택의 정확한 값과 승인 상태·evidence는 [`../rules/auth-runtime.md`](../rules/auth-runtime.md)의 PostgreSQL 선택 구간만 따른다. 선택 승인은 실제 dependency/ESM/DB/platform compatibility 검증이나 운영 architecture를 확정하지 않는다. 다음 사항은 아직 결정되지 않았다.

- PostgreSQL 운영 deployment·volume·backup/restore 절차
- Web/mobile client, 실제 Desktop 지원 OS·배포 identity·callback/protocol 등록값 및 native 저장/복귀 검증
- Shared package의 종류와 dependency direction
- 탈퇴 state·삭제/재가입·백업 복원 및 provider별 미확인 gate
- Production deployment topology

미정 사항을 구현해야 하면 AI는 임의로 architecture를 확정하지 않고 사용자에게 대안과 trade-off를 제시한다.

## Authentication boundary contract

[PR #48 사용자 승인](https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519)으로 중앙 API의 provider 교환·PostgreSQL identity/session과 Desktop public client의 외부 browser 로그인 contract가 승인됐다. HTTP/앱 boundary는 [`../rules/auth-api.md`](../rules/auth-api.md), OAuth는 [`../rules/auth-oauth.md`](../rules/auth-oauth.md), session은 [`../rules/auth-session.md`](../rules/auth-session.md), DB는 [`../rules/auth-database.md`](../rules/auth-database.md), 검색 활동은 [`../rules/auth-activity.md`](../rules/auth-activity.md), dependency·미결정 gate는 [`../rules/auth-runtime.md`](../rules/auth-runtime.md)가 canonical Rule이다.

위 승인은 서버 인증/DB contract 범위다. 추가로 [PR #60 사용자 승인](https://github.com/blahaj94/ldb/pull/60#issuecomment-5553807475)으로 Desktop main/IPC/화면, 인증 lifecycle, OS 저장·protocol 설계가 승인됐다. Canonical contract는 [`../rules/desktop-auth.md`](../rules/desktop-auth.md), [`../rules/desktop-auth-lifecycle.md`](../rules/desktop-auth-lifecycle.md), [`../rules/desktop-auth-platform.md`](../rules/desktop-auth-platform.md)다.

설계 승인은 현재 구현·검증 성공을 뜻하지 않는다. 새 shared package/import direction, Web/mobile client, 실제 Desktop 지원 OS·domain/protocol 등록값·native 검증, deployment topology, 탈퇴 state/삭제·재가입·백업 복원은 계속 미정이다. 사용자의 미결정 gate 유지와 구현 금지 조건에 따라 별도 착수 지시 전에는 구현하지 않는다.

## Architecture change

다음은 architecture 변경으로 취급한다.

- 새 app 또는 shared package 추가
- App source 사이의 직접 import 또는 새로운 dependency direction
- App 사이의 API contract와 통신 방식 변경
- Runtime, persistence, authentication, deployment boundary 도입 또는 교체
- 기존 module 전체 교체

Architecture 변경은 [`../rules/change-control.md`](../rules/change-control.md)의 approval workflow를 따른다.
