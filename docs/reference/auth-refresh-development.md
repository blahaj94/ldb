---
type: reference
scope: apps/api internal refresh transaction core
last-reviewed: 2026-09-06
---

# Refresh transaction core 개발

`apps/api/src/auth/refresh/index.ts`의 `rotateRefresh({ dataSource, issueAccessJwt }, rawToken)`은 이미 발급된 refresh로 rotation하는 내부 진입점이다. `rawToken`만 credential 입력으로 받고 user/session ID를 받지 않는다. 기존 `createAccessJwtIssuer`가 만든 issuer와 기존 DataSource를 주입한다. `/auth/refresh` HTTP 연결과 기본 main 활성화는 구현하지 않았다.

Contract는 `docs/rules/auth-session.md`, `docs/rules/auth-database.md`, `docs/rules/auth-api.md`를 따른다. 기존 schema·Migration·dependency·JWT interface를 변경하지 않았다. 공통 `REFRESH_TOKEN`, `AUTH_ERRORS`, `LOGIN.idleSeconds`와 기존 요청 구조 오류 정의를 읽기 재사용한다.

## Transaction과 실패 결과

Core가 `DataSource.transaction('READ COMMITTED', ...)`를 호출하여 transaction·commit·release를 소유한다. 호출자는 transaction manager나 아직 commit되지 않은 결과를 받지 않으며, 이 함수를 다른 transaction callback 안에 합성하지 않는다.

- Canonical base64url의 32 decoded bytes를 strict 검증하고 그 bytes의 SHA-256으로 hash 이력을 찾는다. 잠금 없는 token/session 조회는 잠글 ID의 hint다. 같은 transaction manager의 typed Repository로 user→session→refresh를 잠근 뒤 fresh DB 정수 초를 읽고 존재·소유·hash·revoked·idle을 다시 검사한다.
- Current이면 새 random bytes와 기존 JWT issuer의 결과를 준비하고 기존 `consumed_at` UPDATE와 새 hash INSERT를 같은 transaction에서 수행한다. `last_active_at`은 쓰지 않는다. 결과는 callback 내부의 `issued` 값으로만 보관하다 commit·release 성공 후 반환한다.
- 유효 session의 consumed token이면 해당 session의 `revoked_at`/`refresh_reuse`를 저장하고 `reuse-revoked` 결과를 반환한다. Transaction 안에서 거절 오류를 throw하지 않으므로 폐기는 commit된다. Core는 commit 확인 후 `AUTHENTICATION_REQUIRED`를 throw한다.
- Signing·entropy 실패는 `AUTH_INTERNAL_ERROR`다. DB 쓰기 실패·random unique 충돌은 `AUTH_UNAVAILABLE`이며 이전 소비까지 rollback한다. 오류는 원문 SQL·parameters·cause 없이 정제한다.
- Commit 결과가 불명이면 `AUTH_UNAVAILABLE`로 실패하며 준비한 token을 반환하거나 같은 원문으로 자동 retry하지 않는다. 실제 DB에 rotation/reuse 폐기가 남았는지는 추정하지 않는다. 이미 commit된 rotation의 응답이 유실된 경우 원래 token 재제출은 reuse 폐기를 일으킬 수 있다.

직접 입력의 canonical 형식 실패는 `INVALID_AUTH_REQUEST`(400), 미발급/없는 소유 row/소유 불일치/종료/만료/확인된 재사용은 `AUTHENTICATION_REQUIRED`(401)다. `RefreshFailure`의 code·status·고정 message는 후속 HTTP 계층에서 기존 정제 응답에 연결할 수 있다. Token 결과는 `tokenType`, `accessToken`, `accessTokenExpiresAt`, `refreshToken`, `sessionExpiresAt`이고 두 시각은 UTC ISO 8601이다.

후속 HTTP 작업은 승인된 JSON pre-parser와 `{refreshToken}` shape 검증, no-store·정제 오류 응답·log sink 경계를 연결한 뒤 위 함수를 await하여 결과를 보낸다. 추가 Access JWT 입력이나 임의 user/session 선택 인자를 만들지 않는다. 내부 core test는 이 HTTP 경계 또는 운영 연결의 완료 evidence가 아니다.

## 검증 근거

`apps/api/test/refresh.test.ts`의 7개 unit group은 canonical/decoded hash, 잠금과 fresh time 순서, commit 전 결과 미반환, 폐기 commit 뒤 거절, stale hint·소유 불일치, 정확 idle 경계·JWT cap, 정제 실패와 단일 시도를 검증한다. Test fixture는 `apps/api/test/refresh.fixtures.ts`에 분리했다. Red에서는 새 module 부재로 이 7개만 실패했고 기존 161개는 통과했다. Green에서는 API 전체 168개가 통과했다.

실제 DB 검증은 `apps/api/test-support/database-integration.mjs`의 기존 Docker 수명주기·Migration·fixture 기반에 아래 전용 helper를 연결한다. 별도 Docker harness는 만들지 않았다. 기존 `login-test-control.mjs`의 QueryRunner instrumentation·DB clock·bounded barrier를 읽기 재사용한다.

| #70 AC | 실행 evidence |
| --- | --- |
| 1, 3 | `refresh-rotation.mjs`: decoded hash 저장, 실제 기존 issuer/verifier의 JWT sub/sid/iat/exp, 소비/새 hash와 단일 current row, commit 이후 반환 |
| 2, 7 | `refresh-concurrency.mjs`: `pg_blocking_pids()`로 user/session/refresh 각각 실제 잠금 대기를 확인하고 DB clock이 idle 경계를 지난 뒤 해제하여 발급 거절. Session user와 token session이 hint 이후 바뀐 경우 재조회로 거절 |
| 4, 5 | `refresh-concurrency.mjs`: 같은 R0의 실제 동시 대기에서 1성공/1reuse 거절, R1도 최종 거절. 별도 barrier 경합에서 B가 R0 hint 후 기다리는 동안 A의 R1과 다음 R2까지 먼저 commit한 뒤 B 폐기로 R1/R2 모두 무효 |
| 6 | `refresh-failures.mjs`: signing·entropy·실제 INSERT CHECK 실패·current/old/다른 기기 hash PK 충돌 6개 rollback group. UPDATE 뒤 INSERT 오류와 원래 current 유지, caller의 별도 새 시도 성공. Rotation/reuse 각각 실제 commit/rollback한 뒤 acknowledgement 오류 주입 4개 group에서 결과 미반환·자동 retry 없음 |
| 7 | `refresh-rotation.mjs`: 정확 deadline 전 1초의 JWT cap, equality/초과 거절, 만료 consumed 이력의 폐기 쓰기 없음. 정확 equality는 실제 clock statement 응답을 test에서 고정하여 검증하며 위 실제 대기 만료 test와 구분 |
| 8 | `refresh-rotation.mjs`: 40일 전 session 생성·refresh 발급에도 최근 활동이 있으면 허용, 4번 rotation 뒤 전체 이력 보존, 가장 오래된 consumed 재사용 탐지, 같은 user의 다른 기기와 다른 user snapshot 보존. `refresh-concurrency.mjs`: logout 선행/후행·늦은 결과, hint 뒤 user/session 삭제, 활동의 새 deadline 선commit |
| 9 | Red→Green commit, 아래 필수 command, 독립 review·사용량 snapshot과 Draft PR handoff는 #70과 연결 PR에 기록 |

DB matrix는 rotation/history 2개, concurrency/TTL 12개, failure 10개 scenario group이다. Logout·삭제·활동 경합의 상대편은 통제된 DB transaction이며 해당 endpoint 또는 cleanup 구현이 아니다. Commit 불명은 실제 PostgreSQL commit/rollback 후 QueryRunner에서 acknowledgement 실패를 주입한 검증으로, 물리 network 단절 실험과 구분한다. 세 table의 잠금 대기는 mock 없이 PostgreSQL의 blocking PID로 확인한다.

```bash
pnpm --filter @ldb/api run --sequential '/^(lint|test|typecheck)$/'
pnpm --filter @ldb/api test:database
git diff --check
```

2026-09-06에 Node `24.19.0`, pnpm `11.23.0`, Docker server `29.7.2`, native `linux/arm64/v8`의 PostgreSQL `18.6 (Debian 18.6-1.pgdg13+2)`에서 통과했다. API test는 production build를 포함한다. 기존 catalog·constraint·schema diff·Migration·identity/login·teardown matrix도 함께 통과했다. 승인된 image index/arm64 child digest를 기존 harness가 확인했다. `linux/amd64`, 실제 provider, `/auth/refresh` HTTP, logout/계정/cleanup/검색 연결, Desktop와 운영 배포·clock 검증은 이번 evidence에 포함되지 않는다.

`rotateRefreshForTest`는 random 실패/충돌을 위한 test 전용 주입 경계이며 환경변수나 HTTP 입력으로 노출하지 않는다. #68의 Google source·test를 이 branch에 복제하지 않았다. 공유 harness·Reference는 #68 고정 head 확인 후 refresh 최소 delta만 작성하며 먼저 merge된 병렬 PR 이후 최신 main rebase와 전체 validation을 따른다.
