---
type: rule
status: active
enforcement: approval-required
scope: architecture
last-reviewed: 2026-08-28
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

- `apps/api`: API application을 위한 workspace. 현재 execution implementation과 test framework는 정해지지 않았다.
- `apps/web`: React, TypeScript, Vite 기반 web application.
- `apps/desktop`: Electron, React, TypeScript, electron-vite 기반 desktop application.
- `packages/*`: shared package를 위한 예약 boundary. 현재 tracked package는 없다.
- `scripts`: repository 생성·관리 script.

상세한 file과 command 현황은 [`../reference/repository-map.md`](../reference/repository-map.md)를 따른다.

## Approved boundary

현재 승인된 architecture는 workspace와 app boundary까지다. 다음 사항은 아직 결정되지 않았다.

- API runtime과 framework
- Database와 schema 관리 방식
- Web, desktop, API 사이의 contract와 transport
- Shared package의 종류와 dependency direction
- Authentication과 authorization 구조
- Production deployment topology

미정 사항을 구현해야 하면 AI는 임의로 architecture를 확정하지 않고 사용자에게 대안과 trade-off를 제시한다.

## Architecture change

다음은 architecture 변경으로 취급한다.

- 새 app 또는 shared package 추가
- App source 사이의 직접 import 또는 새로운 dependency direction
- App 사이의 API contract와 통신 방식 변경
- Runtime, persistence, authentication, deployment boundary 도입 또는 교체
- 기존 module 전체 교체

Architecture 변경은 [`../rules/change-control.md`](../rules/change-control.md)의 approval workflow를 따른다.
