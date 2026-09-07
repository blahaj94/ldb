---
type: reference
status: active
enforcement: autonomous
scope: repository
last-reviewed: 2026-09-07
---

# Repository Map

이 file은 현재 repository의 사실을 설명하는 Reference document다. AI가 code와 config 변경에 맞춰 자율적으로 갱신한다.

## Workspace

- Package manager: `pnpm@11.23.0`
- Workspace pattern: `apps/*`, `packages/*`
- Root package: `@ldb`
- Root type: ESM

## Applications

### `apps/api`

- Package: `@ldb/api`
- Type: ESM
- Stack: Node 24, NestJS 12, TypeScript
- Entry: `src/main.ts` → `dist/main.js`
- 필수 runtime 설정: `PORT`의 ASCII 십진 정수 `1`~`65535`
- Test compile: `test`가 `dist`를 먼저 clean build한 뒤 `src`, `test`를 `.test-dist`로 compile한다. 단독 실행에서도 runtime entry와 login test가 최신 production output을 사용한다. Test module의 loopback HTTP로 runtime을 검증한다.
- Database: `src/database/schemas`의 typed EntitySchema가 ORM mapping과 Migration 생성의 시작점이다. 작성 순서·생성 한계는 [`database-development.md`](database-development.md)를 참고한다. `src/database/data-source.ts`의 compiled ESM DataSource와 `src/database/cli.ts`의 정제된 CLI가 `src/database/migrations`의 auth 초기 Migration을 명시 실행한다. 기본 `AppModule`은 DB module을 연결하지 않는다.
- Auth 정의: `src/constants/auth.ts`의 provider·오류·nickname·refresh 값에서 `src/types/auth.ts`의 공통 타입을 파생한다. Identity session 오류는 `src/errors/identity-session.ts`가 관리한다.
- Identity session: `src/auth/identity-session.ts`가 검증된 provider identity에서 회원·독립 session·최초 refresh를 생성한다. 호출자의 active READ COMMITTED manager에 합성하며 commit 성공 이후에만 token을 전달한다. 사용 경계와 실제 DB 검증은 [`database-development.md`](database-development.md)의 Identity session 절을 참고한다. 공통 로그인 exchange와 Google 내부 adapter의 격리 연결을 구현했으며 실제 등록/credential은 별도 gate다.
- 공통 로그인: `src/auth/login/service.ts`가 요청·launch·callback claim·일회용 exchange를 처리하고 기존 identity-session과 `src/auth/access-jwt` issuer를 같은 transaction에 합성한다. `src/auth/login/http.ts`의 Nest factory는 실제 HTTP 경계다. `src/auth/google`은 jose RS256 검증과 trusted token/JWKS·historical secret resolver를 연결한다. 기본 AppModule/main 활성화와 실제 등록/key/secret 저장소 검증은 gate로 남겨 두었다. Google 연결점·격리 검증 범위는 [`auth-login-development.md`](auth-login-development.md)를 참고한다.
- Refresh/logout HTTP: 기존 Nest factory의 선택적 session service가 `POST /auth/refresh`, `POST /auth/logout`을 같은 16,384-byte strict JSON parser와 정제 filter에 연결한다. `src/auth/refresh`의 기존 transaction ownership을 유지하고 `src/auth/logout`이 제출 token의 해당 session만 종료한다. 기본 AppModule/main 활성화는 하지 않았다. Source·격리 검증 범위는 [`auth-refresh-development.md`](auth-refresh-development.md)를 참고한다.
- Account HTTP: 기존 Nest factory의 선택적 account dependency가 `GET /me`, `PATCH /me/nickname`을 연결한다. `src/auth/account`가 기존 JWT verifier와 user→session 잠금을 재사용해 활동 commit 후 기능 transaction을 재확인하고 nickname을 native Unicode grapheme 기준으로 검증한다. 연결점과 HTTP/DB 경합 evidence는 [`auth-account-development.md`](auth-account-development.md)를 참고한다.
- Database CLI 설정: `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`. 이 값은 DB command와 DB module을 실제 연결할 때만 필요하다.
- Migration 설정: `synchronize:false`, `migrationsRun:false`, `migrationsTransactionMode:'all'`. TypeORM은 최초 up에서 내부 history table을 먼저 준비하고, auth DDL과 해당 history row는 Migration의 active transaction 안에서 적용한다. `db:migrate:show`는 fresh DB에 history table을 만들지 않는 read-only 조회다.
- Docker integration: `test-support/database-integration.mjs`가 고정 PostgreSQL image를 native platform의 isolated container·named volume·loopback dynamic port에서 검증하고 run ownership이 일치하는 exact resource만 정리한다.
- Command:
  - `pnpm --filter @ldb/api dev`
  - `pnpm --filter @ldb/api start`
  - `pnpm --filter @ldb/api test`
  - `pnpm --filter @ldb/api typecheck`
  - `pnpm --filter @ldb/api lint`
  - `pnpm --filter @ldb/api build`
  - `pnpm --filter @ldb/api test:database`
  - `pnpm --filter @ldb/api db:migrate:generate AddUserField` (EntitySchema와 개발 DB 차이로 Migration file 생성)
  - `pnpm --filter @ldb/api db:migrate:up`
  - `pnpm --filter @ldb/api db:migrate:show`
  - `pnpm --filter @ldb/api db:migrate:down` (빈 disposable DB rollback 검증 전용; 운영 자동 실행 아님)

### `apps/web`

- Package: `@ldb/web`
- Stack: React, TypeScript, Vite
- Command:
  - `pnpm --filter @ldb/web dev`
  - `pnpm --filter @ldb/web test`
  - `pnpm --filter @ldb/web typecheck`
  - `pnpm --filter @ldb/web build`
  - `pnpm --filter @ldb/web lint`
  - `pnpm --filter @ldb/web preview`

### `apps/desktop`

- Package: `@ldb/desktop`
- Stack: Electron, React, TypeScript, electron-vite
- Process boundary: `main`, `preload`, `renderer`
- Main entry: `src/backend/main.ts` → `out/backend/main.js`
- Renderer source root: `src/frontend` → `out/frontend`
- Command:
  - `pnpm --filter @ldb/desktop dev`
  - `pnpm --filter @ldb/desktop test`
  - `pnpm --filter @ldb/desktop typecheck`
  - `pnpm --filter @ldb/desktop lint`
  - `pnpm --filter @ldb/desktop build`

## Shared UI

- 실제 검증 환경·결과·upstream Motion 지원 제한: `docs/reference/ui-validation.md`.
- `packages/ui`: `@ldb/ui`, 공식 SEED Snippet·Layout과 중립 Example. Package/peer/CSS 소유·고정 source·고지·명령은 `packages/ui/README.md`를 따른다.
- Library: `pnpm --filter @ldb/ui test`, `typecheck`, `lint`, `build`.
- 독립 Example: `pnpm --filter @ldb/ui dev:examples`, `build:examples`, `preview:examples`. 별도 app workspace는 만들지 않는다.
- Web/Desktop renderer/Example의 source resolution과 cold regression: `packages/ui/README.md`, `packages/ui/test/consumer-resolution.md`. 소비 command는 사전 library build를 요구하지 않는다.
- 각 consumer는 SEED base.css와 별도 공용 foundation.css를 browser entry에서 한 번 import한다. Library JS는 CSS를 import하지 않고 SEED/React/JSX runtime을 external 처리한다.
- Source 재생성·hash/local diff: `packages/ui/scripts/prepare-seed-source.mjs`, `packages/ui/seed-provenance.json`.
- 산출물 검증: `node packages/ui/scripts/verify-build.mjs library packages/ui/dist`, `consumer` mode로 Example·Web·Desktop renderer 산출물을 검사한다. 입력 graph의 미사용 dependency도 보수적으로 고지에 포함한다.
- Test-only Electron UI: `apps/desktop/scripts/ui-fixture.mjs`와 `ui-fixture-preload.cts`. `pnpm --filter @ldb/desktop ui:fixture desktop light` 또는 `example dark`로 실제 production renderer/Example을 연다. 제품 main/preload 대신 synthetic source/선택 bridge와 media 거절 stub을 사용하며 capture/OCR 성공을 검증하지 않는다.

## Repository tooling

- `scripts/create-app.mjs`: 새 app workspace 생성 script
- `pnpm create-app`: root에서 생성 script 실행
- `scripts/start-task.mjs`: OPEN Issue 확인 후 최신 main 기반 Issue branch와 worktree 생성
- `pnpm start-task <Issue 번호> <새 worktree 경로>`: root에서 작업 준비; GitHub CLI 인증 필요
- 작업 준비와 workspace별 native validation 예제: [`scripts/README.md`](../../scripts/README.md)
- Root `test` script는 현재 placeholder이며 성공하는 validation command가 아니다.

### Agent 사용량 보고

- Local command: `scripts/agent-usage.mjs`의 `begin`, `turns`, `snapshot`, `publish`
- 범위 집계: `scripts/agent-usage/collect.mjs`
- Snapshot 검증과 Markdown 보고: `scripts/agent-usage/report.mjs`
- PR snapshot과 Issue comment 갱신: `scripts/agent-usage/github.mjs`
- Merge event와 수동 재시도: `.github/workflows/agent-usage-report.yml`
- Test: `node --test scripts/agent-usage/test/*.test.mjs`
- 실행 시점, 옵션과 syntax check: [`scripts/README.md`](../../scripts/README.md)

Worker가 local manifest에 작업 시작 범위를 기록하고 handoff 전에 aggregate snapshot을 PR comment에 저장한다. Workflow는 merge된 same-repository PR의 유효한 snapshot으로 연결된 Issue에 사용량과 실제 agent model/effort를 게시한다. 내부 task/turn ID와 raw 로그는 GitHub에 전송하지 않으며, snapshot 이후 사용량은 보고에 포함되지 않을 수 있다.

### AI PR review

- Unprivileged signal workflow: `.github/workflows/ai-pr-review.yml`
- Trusted policy/provider workflow: `.github/workflows/ai-pr-review-trusted.yml`
- Review contract: `.github/ai-review/prompts/review.md`
- Provider-neutral result schema: `.github/ai-review/schemas/review-result.schema.json`
- Runtime와 policy check: `scripts/pr-review/src`
- Test: `scripts/pr-review/test`
- Command:
  - `pnpm test:pr-review`
  - `pnpm typecheck:pr-review`

Signal workflow는 same-repository의 non-draft Pull Request에 `@ldb-review` label이 있을 때만 실행한다. `labeled`, `synchronize`, `ready_for_review`, `reopened` event를 처리하며 fork Pull Request는 제외한다. PR code를 checkout하지 않고 write permission과 Secret을 받지 않는다.

Trusted workflow는 signal workflow가 완료된 뒤 `workflow_run`으로 실행된다. Default branch code만 checkout하고 source workflow result, linked Pull Request, label, draft, fork, current head SHA를 GitHub API로 다시 확인한다. Policy job과 provider trigger job을 분리하며 PAT는 provider trigger job에만 전달한다.

현재 provider adapter는 `codex`다. Provider-neutral label을 Codex GitHub integration의 `@codex review` comment로 변환하며, 동일한 head SHA에는 한 번만 요청한다. Trigger identity는 repository Secret `LDB_REVIEW_TRIGGER_TOKEN`을 사용한다. 이 값은 `ldb` repository만 선택한 expiring fine-grained PAT이며 `Pull requests: Read and write` 이외의 추가 repository permission을 부여하지 않는다.

Repository Secret `LDB_REVIEW_TRIGGER_TOKEN`은 2026-08-29에 등록했다. 같은 날 controlled pilot PR #5에서 signal, trusted Policy job, 사용자 identity provider trigger, Codex review, P1 inline finding, same-head deduplication E2E가 모두 통과했다. Pilot PR은 merge하지 않고 닫았다.

Built-in Codex review는 `P0`와 `P1` finding만 발행하므로 `P2`와 `P3` summary publication은 향후 direct provider integration 범위다.

Workflow가 자체적으로 확인하는 policy는 linked Issue, Rule approval, Red-before-Green evidence, approximate logic budget이다. 결과는 하나의 advisory summary comment로 유지되며 merge를 차단하지 않는다.

## Generated and dependency output

다음 directory는 일반적인 architecture context로 읽지 않는다. 관련 Issue가 직접 다룰 때만 확인한다.

- `node_modules`
- `dist`
- `out`
- build artifact와 cache

## Update trigger

다음 변경이 생기면 이 Reference document를 같은 PR에서 갱신한다.

- Workspace, app, package 추가·삭제·이름 변경
- Runtime 또는 주요 framework 변경
- 표준 command 변경
- Process boundary 또는 source root 변경
