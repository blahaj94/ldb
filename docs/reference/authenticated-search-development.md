---
type: reference
scope: apps/api authenticated character search HTTP, activity, quota and cancellation
last-reviewed: 2026-09-07
---

# 인증된 캐릭터 검색 개발

`apps/api/src/auth/login/http.ts`의 `createLoginHttpApp`은 선택적 네 번째 인자 `searchDependencies`로 `GET /characters`를 연결한다. 필수 주입 값은 기존 `dataSource`, `verifyAccessJwt`, `apiKey`다. 기존 login·refresh/logout·account 연결을 유지하며 기본 `AppModule`과 `main.ts`의 운영 활성화는 하지 않는다.

Contract는 `docs/rules/character-search.md`, `docs/rules/auth-activity.md`, `docs/rules/auth-session.md`, `docs/rules/auth-database.md`, `docs/rules/auth-runtime.md`가 정의한다. Schema·Migration·JWT verifier·순수 Neople adapter는 기존 구현을 사용한다. 새 Development dependency `@types/pg 8.23.1`의 승인은 `docs/rules/auth-runtime.md`의 PR #118 evidence를 따른다.

## 입력과 HTTP 경계

`apps/api/src/characters/authenticated-search.ts`는 단일 Bearer JWT → original URL query → API key 설정 → account admission 순서로 처리한다. `apps/api/src/auth/bearer.ts`는 원본 header pair의 중복과 exact Bearer 형태만 검사하며 JWT signature·claim 검증은 기존 verifier가 담당한다. Account service도 이 작은 parser만 공유한다.

`apps/api/src/characters/query.ts`의 진입 함수는 `decodeRawQuery` → `validateSearchQuery` 두 단계를 보여 준다. 첫 단계는 첫 `?` 뒤의 raw query를 `&`와 각 component의 첫 `=`로 나누고 `+`를 space로 바꾼 뒤 한 번 strict decode한다. 잘못된 escape·UTF-8은 거절하며 decoded pair 목록의 중복은 그대로 보존한다. 두 번째 단계가 unknown/bracket/duplicate key를 거절한 뒤 code point 길이·공백·server map·십진 limit을 검증한다. 생략한 server와 limit에만 `all`, `10`을 적용한다.

`apps/api/src/characters/http.ts`는 HEAD→GET fallback을 인증·활동 전에 차단한다. 요청의 응답 연결이 완료 전에 끊어지면 admission의 abort signal을 취소한다. 기존 login filter는 `/characters`의 `NeopleSearchFailure`를 정제된 JSON으로 보존하고 429에는 정수 `Retry-After`를 붙인다. 모든 응답의 no-store 설정을 유지한다.

## Admission과 활동 순서

`apps/api/src/characters/search-admission.ts`는 검증된 JWT account key별로 admission만 직렬화한다. 최근 예약은 monotonic clock의 `(t - 60,000ms, t]`에 들어온 최대 10개다. Capacity 초과는 DB 진입 전에 즉시 429이며 quota가 풀리기를 기다리는 queue가 없다.

1. Capacity가 남으면 `apps/api/src/characters/search-activity.ts`가 하나의 READ COMMITTED transaction에서 `sid AND user_id=sub`의 session만 잠근다.
2. 잠금/조회 뒤 DB `clock_timestamp()`를 floor한 정수 초 T로 JWT iat/exp를 재검사한다. 존재하는 미폐기 session은 같은 T로 idle 만료를 검사하고 활동을 이전 값보다 뒤로 가지 않게 갱신한다.
3. 없는 session과 revoked session은 활동 없이 residual 경로를 통과한다. User 조회·upsert·복원은 하지 않는다.
4. DB commit과 연결 종료가 확인되면 최종 monotonic 시각에 예약하고 같은 실행 구간에서 기존 adapter를 바로 시작한다. 예약과 adapter 시작 사이에는 await·DB 작업이 없다. 이후 admission을 해제하고 upstream 응답을 기다린다.

Post-lock T에서 인정된 JWT를 commit 뒤 다시 만료 처리하지 않는다. 성공·빈 결과·upstream 오류·5초 timeout에는 예약과 인정한 활동이 남는다. 최근 예약이나 살아 있는 admission이 있는 동안만 account entry를 유지한다. 만료 timer가 살아 있는 admission의 entry를 교체하지 않으며 취소한 waiter는 즉시 제거한다.

## 요청별 연결과 취소

`apps/api/src/characters/search-deadline.ts`는 admission 대기 시작부터 DB 처리까지 하나의 2초 deadline을 적용한다. Deadline과 HTTP disconnect는 같은 abort signal을 통해 waiter와 요청 소유 연결을 취소한다. 늦은 lock/commit callback은 단계별 deadline 검사에 막혀 예약이나 upstream을 시작하지 못한다.

`apps/api/src/characters/search-query-runner.ts`는 TypeORM 1.1.1이 export하는 `PostgresQueryRunner`의 public connect/release를 작은 adapter로 구현한다. 각 요청은 별도 `pg.Client`와 그 runner의 EntityManager를 사용한다. Pool acquisition을 하지 않으므로 기존 TypeORM pool이 고갈돼도 취소할 수 없는 pool waiter를 만들지 않는다. 정상 완료와 실패 모두 그 연결을 종료한다. 다른 service의 pool·transaction은 변경하지 않는다.

PG 8.23.0의 non-pipeline `Client.end()`는 진행 중 query의 client socket을 실제 종료한다. Connecting 중 `end()`가 connect callback을 호출하지 않는 경우도 있어, adapter가 자신의 연결 Promise를 정제 reject하고 실제 socket 종료 완료는 별도로 기다린다. Late callback/error로 종료된 runner가 다시 사용 가능해지지 않는다. Private pool queue나 TypeORM private release callback은 사용하지 않는다.

PostgreSQL 18의 기본 `client_connection_check_interval=0`에서는 client가 닫힌 뒤에도 server가 lock 대기에 남는 회귀를 실제로 확인했다. 해당 검색 연결의 startup 옵션에만 `client_connection_check_interval=100ms`를 적용해 실행 중 query가 끊긴 socket을 확인하도록 한다. 전역 PostgreSQL 설정을 변경하지 않으며, HTTP의 2초 deadline과 server cleanup 완료는 구분한다. [PostgreSQL 공식 설명](https://www.postgresql.org/docs/18/runtime-config-connection.html#GUC-CLIENT-CONNECTION-CHECK-INTERVAL)에 따라 이 검증은 지원되는 Linux Docker 환경의 연결 종료에 한정한다. 임의의 network partition이나 모든 운영 환경에서 정확히 같은 시간 안에 정리된다는 보장은 아니다.

DB read/write/commit 실패와 timeout은 검색용 정제 500이며 예약·upstream은 0이다. Commit acknowledgement 불명은 활동이 commit됐을 수 있으므로 rollback을 확정하지 않는다. Application 종료 hook은 모든 진행 중 admission을 abort하고 DB activity Promise의 정리를 기다린다. Client 종료와 실제 PostgreSQL backend 소멸은 test에서 따로 관측한다.

직접 연결은 DataSource의 PostgreSQL host/port/username/password/database/url/ssl 값을 사용한다. TypeORM 1.1.1의 SSL type은 server용 `TlsOptions`로 선언되어 pg의 client TLS type과 차이가 있어 해당 경계만 type cast하고 값을 그대로 전달한다. 실제 운영 TLS·replication·추가 driver option의 compatibility를 검증한 것은 아니다. 요청마다 연결을 여는 비용과 ingress/pending-request 상한은 운영 검토 대상으로 남아 있다.

## 검증 경계

`apps/api/test-support/character-search-*.test.mjs`는 parser·HTTP 우선순위, quota clock/entry 수명, connecting socket 취소, late callback/error, 단일 admission/DB budget과 service 종료를 검증한다. Service의 DB double을 실제 PostgreSQL 취소 evidence로 사용하지 않는다.

`apps/api/test-support/character-search-http-integration.mjs`는 기존 Docker-only `database-integration.mjs`에 연결된다. `character-search-fixtures.mjs`가 기존 JWT/identity fixture와 실제 loopback upstream을 조합하며 production dependency 주입 경계에서 QueryRunner를 관측한다. 검색은 해당 factory를 실제로 사용하므로 기존 DataSource pool factory에 연결되지 않은 spy로 DB 호출 0을 주장하지 않는다.

| 검증 | 관측 내용 |
| --- | --- |
| 실제 검색과 입력 거절 | 실제 JWT·session 활동 commit·upstream encoding/projection, auth/raw/config 우선순위와 최초 거절의 state 불변 |
| 동시 quota | 11개 요청의 10회 허용/1회 429, 여러 session·조건 합산, 다른 account 독립. Upstream 응답을 보류한 동안에도 admission이 진행 |
| 예약 시각 | Capacity 시각이 아닌 commit 이후 시각의 60초 경계, 최종 clock 조회와 adapter 사이 microtask yield 없음, residual 차감과 실패 무차감 |
| 만료와 residual | iat/exp/idle 정확 경계, 실제 session lock 대기 중 만료, logout·삭제 뒤 잔여 JWT의 활동/복원 0, 활동 commit 뒤 logout/삭제 및 JWT 경과 |
| DB 실패와 취소 | Read/write 실패, 실제 commit/rollback 뒤 acknowledgement 오류, 실제 lock waiter의 2초 500와 backend 소멸, 늦은 commit 결과의 no-call |
| 연결과 종료 | Active/queued HTTP disconnect, application 종료, 별도 pool 고갈 중 검색 성공, connecting abort 후 socket 부재와 pre-abort의 실제 연결 0 |
| Upstream와 노출 | 빈 결과·잘못된 후보·실제 5초 body timeout의 활동/예약 유지, 오류 우선순위, 정제 응답과 process stdout/stderr의 credential·identity canary 비노출 |

Exact time test의 DB clock 응답 고정과 실제 lock 대기 만료는 별개다. Read/write/commit acknowledgement 오류는 QueryRunner fault injection이며 물리 commit packet 유실 실험이 아니다. Log canary는 같은 process의 관측이며 운영 proxy/APM 전체 검증을 뜻하지 않는다.

```bash
pnpm --filter @ldb/api run --sequential '/^(lint|test|typecheck)$/'
pnpm --filter @ldb/api test:database
git diff --check
```

2026-09-07 Worker 검증에서 API aggregate의 267개 test와 전용 실제 DB 검색 34개 scenario를 포함한 Docker aggregate가 통과했다. 최종 통합 실행 evidence는 구현 PR에서 exact head와 연결한다. API aggregate의 test는 production build를 포함한다. 현재 검증 환경은 Node `v24.19.0`, pnpm `11.23.0`, Docker server `29.7.2`, native `linux/arm64/v8`, PostgreSQL `18.6 (Debian 18.6-1.pgdg13+2)`다. 승인된 image index/arm64 child digest와 exact resource teardown을 기존 harness가 확인한다. `linux/amd64`, 실제 provider/credential, 기본 main 구성, Desktop, 운영 TLS·배포·ingress·proxy/APM·clock 동기화는 이 격리 검증의 완료 범위가 아니다.
