---
type: rule
status: active
enforcement: approval-required
scope: architecture
last-reviewed: 2026-09-07
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

PostgreSQL server·image·local validation 선택의 정확한 값과 승인 상태·evidence는 [`../rules/auth-runtime.md`](../rules/auth-runtime.md)의 PostgreSQL 선택 구간만 따른다. 그 선택 승인만으로 실제 dependency/ESM/DB/platform compatibility 검증이나 구체 운영 image/volume을 확정하지 않는다. 인증 운영 설계의 추가 승인은 아래 Authentication boundary contract를 따르며, 다음 사항은 구체 결정·확보 또는 검증이 남아 있다.

- 승인된 인증 운영 설계에 필요한 실제 장비·volume·backup/restore 실행 검증
- Web/mobile client, 실제 Desktop 지원 OS·배포 identity·callback/protocol 등록값 및 native 저장/복귀 검증
- 아래 Shared UI boundary 제안 이외의 shared package 종류와 dependency direction
- 승인된 탈퇴·삭제/재가입·백업 복원 정책의 실제 저장소·권한·provider·실행 검증 gate
- 승인된 인증 운영 배치 외의 Production deployment topology

미정 사항을 구현해야 하면 AI는 임의로 architecture를 확정하지 않고 사용자에게 대안과 trade-off를 제시한다.

## Authentication boundary contract

[PR #48 사용자 승인](https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519)으로 중앙 API의 provider 교환·PostgreSQL identity/session과 Desktop public client의 외부 browser 로그인 contract가 승인됐다. HTTP/앱 boundary는 [`../rules/auth-api.md`](../rules/auth-api.md), OAuth는 [`../rules/auth-oauth.md`](../rules/auth-oauth.md), session은 [`../rules/auth-session.md`](../rules/auth-session.md), DB는 [`../rules/auth-database.md`](../rules/auth-database.md), 검색 활동은 [`../rules/auth-activity.md`](../rules/auth-activity.md), dependency·미결정 gate는 [`../rules/auth-runtime.md`](../rules/auth-runtime.md)가 canonical Rule이다.

위 승인은 서버 인증/DB contract 범위다. 추가로 [PR #60 사용자 승인](https://github.com/blahaj94/ldb/pull/60#issuecomment-5553807475)으로 Desktop main/IPC/화면, 인증 lifecycle, OS 저장·protocol 설계가 승인됐다. Canonical contract는 [`../rules/desktop-auth.md`](../rules/desktop-auth.md), [`../rules/desktop-auth-lifecycle.md`](../rules/desktop-auth-lifecycle.md), [`../rules/desktop-auth-platform.md`](../rules/desktop-auth-platform.md)다.

탈퇴 D1–D5의 정책은 [승인된 탈퇴 contract](../rules/auth-withdrawal-proposal.md)를 따른다. [PR #132 사용자 승인](https://github.com/blahaj94/ldb/pull/132#issuecomment-5572391826)으로 추천 3대 배치·독립 journal/witness·권한·보관의 [인증 운영 구성](auth-operations-proposal.md)과 복원 실행 조건·장애 matrix의 [운영 검증 기준](auth-operations-validation-proposal.md)이 active Rule이 됐다. `age`는 도입 후보 방향만 승인됐으며 exact version/binary와 실제 환경·운영 검증은 남아 있다.

설계 승인은 현재 구현·검증 성공을 뜻하지 않는다. 아래 UI 제안과 별개인 shared package/import direction, Web/mobile client, 실제 Desktop 지원 OS·domain/protocol 등록값·native 검증, 탈퇴·복원의 구체 운영 환경/통합 검증은 미결정 gate를 유지한다. PR merge·환경 확보·구현·실제 복원 검증을 설계 승인과 구분하며 별도 착수 지시 전에는 구현하지 않는다.

## Shared UI boundary

[Issue #86의 SEED 채택 결정](https://github.com/blahaj94/ldb/issues/86#issuecomment-5560112909)에 따라 다음 boundary를 이 변경을 담은 Draft PR에서 제안한다. 기존 active architecture와 인증·API·domain·platform contract는 유지한다. 이 제안의 명시적 PR 승인과 후속 작업의 실행 허용 전에는 package 생성·dependency 설치·제품 교체를 진행하지 않는다. 현재 tracked package가 없다는 topology 설명은 구현 현황이다.

| 대상 | 책임과 dependency direction |
| --- | --- |
| `packages/ui`의 `@ldb/ui` | Browser React shared package 하나로 공식 SEED styled Component·Snippet·Layout과 도메인 중립 composition을 제공한다. `@ldb/ui` → SEED/React·필요한 공식 icon 방향으로 연결하며 app source·API client·backend·Electron main/preload·IPC·인증·domain을 import하지 않는다. |
| `apps/web`·`apps/desktop` renderer | `@ldb/ui`를 소비하고 제품 data·event·behavior와 app별 platform 연결을 맡는다. 서로의 source를 import하지 않는다. Desktop main/preload는 UI package를 소비하지 않는다. |
| 독립 Vite Example entry | 같은 repository에서 같은 `@ldb/ui` public API를 소비한다. 제품 runtime·backend·preload에 의존하지 않고 중립 content로 Component·Pattern·Template을 실행한다. 새 제품 app이나 자체 gallery framework를 만들지 않는다. |

공식 요소를 불필요하게 재명명·wrapper로 감싸지 않고 SEED 이름과 semantic API를 유지한다. 화면별 외형 override 제한, 최초 Example 범위, 고정 version·Snippet source와 향후 검증 matrix는 [`design-system.md`](../rules/design-system.md)가 canonical Rule이다.

### Dependency와 CSS 소유

[공식 Library Authors 가이드](https://seed-design.io/react/getting-started/library-authors)를 따른다.

- `@ldb/ui`는 `@seed-design/react`, `@seed-design/css`, React·React DOM을 peer dependency로 선언한다. 개발·test에 필요한 사본은 dev dependency로 둔다. SEED React와 CSS의 peer 범위를 각각 명시하고, 소비 app·Example은 Design System Contract의 동일한 exact SEED 조합을 제공한다. React도 소비 환경과 일치시키며 검증하지 않은 지원 범위를 주장하지 않는다.
- Library를 bundle하면 `@seed-design/*`와 React·React DOM 및 JSX runtime entry를 external 처리한다. 산출물에 별도 SEED runtime·CSS 또는 React 사본이 포함되지 않는지 확인한다. Peer 선언만으로 external 처리가 보장된다고 가정하지 않는다.
- Library source에서 `@seed-design/css/*.css`를 직접 import하지 않는다. 선택한 공식 Vite 통합은 `base.css`와 Component recipe CSS를 사용하는 경로다. 이 경로에서 각 소비 app·Example의 browser entry가 `@seed-design/css/base.css`를 한 번 import하고 Theme 초기화 책임을 가진다. SEED recipe가 연결하는 Component CSS를 library의 별도 CSS 사본으로 vendor하지 않는다.
- Web·Desktop renderer·Example은 공식 `@seed-design/vite-plugin` 통합을 사용한다. Desktop의 electron-vite renderer 설정과 실제 Electron 실행 호환성은 후속 검증 대상이다. 하나의 alias만을 위해 `vite-tsconfig-paths`를 추가하지 않고 기존 Vite의 `resolve.alias`를 사용한다.
- 공식 icon package는 필요한 Snippet의 runtime dependency로, CLI는 authoring 도구로 구분한다. CLI를 제품 runtime에 포함하지 않는다. 초기 채택 이외의 dependency·역할 변경은 기존 approval boundary를 따른다.

Package의 published peer 범위는 조합 선정 evidence이며 실제 Web·Electron 호환성, CSS 중복 없음, accessibility·시각 일치 성공을 보증하지 않는다. 구현 시 library 산출물과 각 소비 환경을 검증하고 같은 PR에서 관련 Example과 사용 안내를 유지한다.

## Architecture change

다음은 architecture 변경으로 취급한다.

- 새 app 또는 shared package 추가
- App source 사이의 직접 import 또는 새로운 dependency direction
- App 사이의 API contract와 통신 방식 변경
- Runtime, persistence, authentication, deployment boundary 도입 또는 교체
- 기존 module 전체 교체

Architecture 변경은 [`../rules/change-control.md`](../rules/change-control.md)의 approval workflow를 따른다.
