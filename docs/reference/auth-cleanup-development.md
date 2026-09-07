---
type: reference
status: active
enforcement: autonomous
scope: apps/api authentication cleanup
last-reviewed: 2026-09-08
---

# 인증 데이터의 명시적 정리

`pnpm --filter @ldb/api auth:cleanup`은 production ESM build 후 인증 데이터를 한 번 정리하고 종료한다. 기존 `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` 설정과 `createDatabaseDataSource`를 사용한다. Migration을 자동 적용하지 않으므로 승인된 Migration이 적용된 DB가 필요하다.

## 삭제와 보존

`apps/api/src/auth/cleanup/index.ts`의 `cleanupAuthentication`은 초기화된 DataSource를 받는다. 연결의 생성·종료는 호출자가 맡고 결과는 `sessionsDeleted`, `loginRequestsDeleted`로 반환한다.

- Revoked 또는 `last_active_at + 2,592,000초`에 도달한 session을 삭제한다. FK cascade로 그 session의 refresh 이력 전체를 삭제하며 user는 보존한다.
- 활성 session은 오래된 consumed hash를 포함한 모든 refresh 이력을 보존한다. Refresh 자체는 활동 시각을 연장하지 않는다.
- OAuth 요청은 `consumed`, `failed`이거나 전체 `expires_at`에 도달했을 때 삭제한다. 유효한 `processing` 요청은 provider HTTP가 진행 중이어도 보존한다.
- `exchange_ready`의 `code_expires_at`만 지난 상태는 삭제 조건이 아니다. Code TTL에 따른 교환 거절과 전체 요청의 물리 보관을 구분한다. 이후 terminal 전이 또는 전체 요청 만료가 확인되면 정리한다.

후보 조회는 삭제 권한이 아니다. UUID 순서로 각 row를 별도 READ COMMITTED transaction에서 잠그고, session의 존재·소유관계와 현재 상태를 확인한다. 판정 시각은 잠금 뒤 `clock_timestamp()`의 epoch를 내린 정수 초다. 활동이 먼저 commit하면 연장된 deadline으로 판단하며, 삭제 뒤 기다리던 활동·refresh·callback·exchange는 row를 복원하지 않는다. Session 삭제 뒤에도 유효 JWT의 기존 residual 검색 의미는 유지된다.

정책의 원문은 [`auth-database.md`](../rules/auth-database.md), [`auth-session.md`](../rules/auth-session.md), [`auth-oauth.md`](../rules/auth-oauth.md), [`auth-activity.md`](../rules/auth-activity.md)를 따른다.

## 실행 결과와 연결 정리

`apps/api/src/auth/cleanup/command.ts`는 이번 실행의 DataSource만 소유한다. 정상 종료와 실패 모두 연결 정리를 기다리며 초기화 완료 표시 전에 실패한 경우에도 driver 연결 해제를 시도한다. Core는 호출자의 DataSource를 닫지 않는다.

Compiled CLI `apps/api/src/auth/cleanup/cli.ts`는 정리와 연결 종료가 모두 성공했을 때만 `Authentication cleanup completed`를 출력한다. 설정·초기화·조회·삭제·commit·연결 종료 실패는 `Authentication cleanup failed`와 종료 코드 1로 끝낸다. 오류 원문·설정값·credential·stack은 출력하지 않는다.

각 row가 따로 commit되므로 뒤의 실패가 앞선 삭제를 되돌리지 않는다. Commit 응답이 유실되면 해당 삭제가 적용됐을 수도 있다. 실패를 전체 rollback 또는 전체 성공으로 해석하지 않으며 자동 retry하지 않는다. 다음 명시 실행은 현재 DB 상태를 다시 조회하므로 이미 삭제된 row를 재생성하지 않는다. 연결 정리 자체의 실패도 성공으로 바꾸지 않는다.

## 검증과 남은 연결

전용 unit/command test는 `apps/api/test-support/cleanup.test.mjs`, `cleanup-command.test.mjs`다. 실제 PostgreSQL 검증은 `cleanup-database.mjs`, `cleanup-session-concurrency.mjs`, `cleanup-oauth-concurrency.mjs`를 기존 `database-integration.mjs`가 호출한다. 별도 Docker harness는 없다.

```sh
pnpm --filter @ldb/api build
pnpm --filter @ldb/api exec node --import reflect-metadata --test test-support/cleanup.test.mjs test-support/cleanup-command.test.mjs
pnpm --filter @ldb/api test:database
```

DB 검증은 활성 이력·OAuth 상태별 보존/삭제, 실제 잠금 대기와 활동·refresh·callback·exchange의 최종 상태, 앞선 commit 이후 실패와 마지막 commit 결과 불명, compiled CLI 연결 종료를 확인한다. 전용 unit/command 25개와 cleanup DB 시나리오 14개가 통과했다. 실제 실행 환경은 Node 24.19.0, Docker 29.7.2, PostgreSQL 18.6의 `linux/arm64/v8`이며 `linux/amd64`는 미실행이다. 실행 evidence는 [Issue #136](https://github.com/blahaj94/ldb/issues/136)에 기록한다. 한 platform의 결과를 다른 platform 또는 실제 운영 검증으로 확대하지 않는다.

시작 시 자동 호출은 아직 연결하지 않았다. 승인된 하루 1회 실행의 운영 연결, 실제 실행 시각과 실패 대응도 미완료다. 이 command만으로 주기 실행이나 10분·24시간 이내 물리 삭제를 보장하지 않는다. 시작 호출은 API 수명주기 작업과, 정기 실행은 운영 후속 작업과 연결해야 한다.
