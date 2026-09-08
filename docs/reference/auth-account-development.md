---
type: reference
scope: apps/api account profile HTTP and activity transactions
last-reviewed: 2026-09-08
---

# 계정 프로필 조회와 nickname 변경 개발

`apps/api/src/auth/login/http.ts`의 `createLoginHttpApp`은 선택적 세 번째 인자 `{ dataSource, verifyAccessJwt }`로 `GET /me`와 `PATCH /me/nickname`을 연결한다. 기존 DataSource와 `createAccessJwtVerifier`의 verifier를 명시적으로 주입한다. 두 번째 session service 인자의 refresh/logout 연결은 유지한다. 기본 main도 이 factory에 계정 dependency를 연결한다. 설정·실행과 기본 entry의 후속 통합 검증은 [`api-start-development.md`](api-start-development.md)를 참고한다.

Contract는 `docs/rules/auth-api.md`, `docs/rules/auth-activity.md`, `docs/rules/auth-session.md`, `docs/rules/auth-database.md`가 정의한다. 기존 schema·Migration·dependency와 JWT issuer/verifier는 변경하지 않았다. 인증 검색과 탈퇴 lifecycle·control store 통합은 이 module의 구현 범위가 아니다.

## 입력과 응답 경계

`apps/api/src/auth/account/http.ts`의 controller는 원본 `rawHeaders`를 account service에 전달한다. Service는 정확히 하나의 Authorization Bearer 값을 기존 verifier에 전달한다. Body/query의 token·user/session ID는 자격으로 사용하지 않는다. 같은 파일의 private `assertAccountGet(method): void`가 Express의 HEAD→GET fallback을 service 호출 전에 차단해 `HEAD /me`의 활동 기록을 막는다. 검사와 기존 `AccountFailure(INVALID_REQUEST)` throw를 묶으며 로그인 오류 정책과 합치지 않는다.

PATCH는 기존 `apps/api/src/auth/login/json-parser.ts`의 media/encoding 검사, 실제 stream 16,384-byte 상한, strict UTF-8와 JSON parser를 먼저 거친다. 이후 JWT를 검증하고 정확한 `{ nickname }` object와 domain을 확인한다. 구조 오류는 `INVALID_AUTH_REQUEST`, nickname 값 오류는 `INVALID_NICKNAME`이다. 두 endpoint의 성공 응답은 `{ user: { id, nickname } }`만 포함하며 모든 성공·오류는 no-store JSON이다. Filter는 `/me`의 GET 오류를 browser login HTML과 구분한다.

`apps/api/src/auth/account/nickname.ts`는 원문 string, lone surrogate, raw Unicode Cc·U+2028·U+2029를 순서대로 검사한 뒤 ECMAScript trim과 `Intl.Segmenter('und', { granularity: 'grapheme' })`를 적용한다. 1–20 grapheme을 허용하며 Unicode normalization이나 내부 공백 변환을 하지 않는다. 중복·즉시 반복 변경을 허용한다.

## 활동과 기능의 transaction 경계

`apps/api/src/auth/account/index.ts`의 service가 서로 다른 READ COMMITTED transaction 두 개를 순서대로 소유한다. Caller가 외부 transaction manager를 합성하거나 미commit 결과를 받는 형태가 아니다.

1. JWT와 입력 검증 뒤 user→해당 user 소유 session을 잠근다. 모든 lock 대기 뒤 DB `clock_timestamp()`를 floor한 정수 초로 session의 revoked·idle과 JWT iat/exp를 확인한다. `last_active_at`은 이전 값보다 뒤로 가지 않게 갱신하고 activity commit·release를 기다린다.
2. 기능 transaction에서 user→session을 다시 잠그고 fresh DB 시각으로 존재·소유·revoked·idle을 재확인한다. JWT는 admission에서 판정했으므로 기능 단계의 시간 경과만으로 JWT를 재판정하지 않는다. GET은 잠근 user의 id/nickname을 반환하고 PATCH는 nickname을 갱신한다. Function commit·release 확인 후에만 HTTP 결과를 전달한다.

최초 인증·입력 거절에는 활동이 없다. 두 번째 단계의 logout·삭제·만료 거절이나 DB read/write 실패는 이미 commit된 활동을 되돌리지 않는다. 삭제 cascade는 존중하며 upsert나 계정/session 재생성은 하지 않는다. DB·commit acknowledgement 불명은 정제 `503 AUTH_UNAVAILABLE`이고 자동 retry나 commit/rollback 확정 주장을 하지 않는다. Function commit이 적용됐지만 acknowledgement를 잃은 경우 nickname이 저장됐어도 HTTP는 성공을 반환하지 않는다.

## 검증 근거와 실행 경계

`apps/api/test-support/account-nickname.test.mjs`는 raw controls·lone surrogate·빈 값·grapheme 경계와 emoji·결합문자·내부 공백 보존을 검증한다. `account-http.test.mjs`는 HEAD의 verifier·DB 호출 차단, JWT 이전 transport 거절, field 이전 JWT 거절, GET JSON 오류, 종료 chunk 이전 즉시 overflow 응답을 검증한다. Content-Length와 Transfer-Encoding 충돌은 Node HTTP framing 거절로 따로 검사하며 제품 JSON 오류로 해석하지 않는다.

`account-http-fixtures.mjs`는 기존 identity/session fixture와 실제 JWT issuer/verifier를 재사용한다. `account-http-integration.mjs`의 50개 scenario가 기존 `database-integration.mjs`의 Docker-only disposable 수명주기와 Migration에 연결된다. HEAD characterization은 assertion 추출 전 기존 구현에서 먼저 통과를 확인했다.

| 검증 경계 | Evidence |
| --- | --- |
| HEAD fallback | 유효 JWT의 `HEAD /me`에서 400·no-store·빈 body와 user/session/token snapshot 불변을 확인하고 같은 JWT의 GET 성공·활동 갱신으로 자격 유효성도 확인 |
| 정상·입력 거절 | 실제 HTTP/DB profile projection, Unicode 저장, 중복·반복 변경, single Bearer, query-only 자격 거절, 구조/domain 거절 후 전체 user/session/token snapshot 불변 |
| 정확한 만료 | 실제 DB clock statement 응답을 고정한 JWT/idle equality 거절, 기능 단계 JWT 경과 허용과 새 idle equality 거절 |
| 실제 lock 대기 | User/session 각각 외부 PostgreSQL lock을 가진 동안 HTTP transaction의 다른 backend PID가 `pg_blocking_pids()`에서 대기함을 관측. 실제 DB clock이 JWT/idle deadline에 도달한 뒤 해제하여 최초 활동 없이 401 |
| Logout·삭제 경합 | Logout HTTP 또는 user 삭제 transaction이 commit 전 lock을 가진 동안 account HTTP waiter를 관측. 반대 순서는 activity commit 이후 barrier에서 logout/삭제를 완료한 다음 기능 재확인의 401·nickname 변경 없음·활동 보존 또는 cascade 결과 확인 |
| DB·commit 실패 | 최초/기능 단계 user read와 nickname UPDATE의 QueryRunner 오류 주입. 두 단계 각각 실제 commit/rollback 후 acknowledgement 오류에서 503, 활동·nickname 최종 상태, token·nickname·identity·원문 오류의 process stdout/stderr 비노출 확인 |

정확 equality의 clock 응답 고정과 실제 lock 대기 만료는 별개 검증이다. Read/write와 commit acknowledgement 오류는 QueryRunner fault injection이며 물리 network 단절 실험이 아니다. Log canary는 같은 process의 stdout/stderr 관측으로, 운영 proxy/APM 전체의 검증을 뜻하지 않는다.

```bash
pnpm --filter @ldb/api run --sequential '/^(lint|test|typecheck)$/'
pnpm --filter @ldb/api test:database
git diff --check
```

2026-09-07의 실행 환경은 Node `v24.19.0`, pnpm `11.23.0`, Unicode `17.0`, ICU `78.3`, Docker server `29.7.2`, native `linux/arm64/v8`, PostgreSQL `18.6 (Debian 18.6-1.pgdg13+2)`다. 기존 harness가 승인된 image index와 arm64 child digest를 대조하고 정상·실패·timeout·SIGINT·SIGTERM·ownership mismatch teardown 및 해당 exact resource 부재를 확인했다. `linux/amd64`, 실제 provider/credential, Desktop, 탈퇴 통합, 운영 배포·proxy/APM·clock·cleanup과 물리 network 단절은 미검증이다.
