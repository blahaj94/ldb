---
type: reference
scope: apps/api common login implementation
last-reviewed: 2026-09-06
---

# 공통 로그인 구현과 연결

`apps/api/src/auth/login`은 승인된 로그인 요청·browser/provider binding·callback claim·일회용 exchange를 구현한다. Canonical contract는 `docs/rules/auth-api.md`, `auth-oauth.md`, `auth-session.md`, `auth-database.md`, `auth-runtime.md`다. 이 Reference는 현재 구현 위치와 검증·연결 경계만 설명한다.

## 현재 실행 경계

`createLoginService`에 초기화된 DataSource, 검증된 registry와 provider PKCE key, 실제 Access JWT issuer, 서버의 provider verifier를 주입한다. `createLoginHttpApp(service)`는 이 service를 실제 Nest HTTP route에 연결하며 기본 body parser를 끄고 인증 pre-parser와 정제 오류 처리를 설치한다. DataSource는 composition 호출자가 소유하고 종료한다.

`apps/api/src/app.ts`의 기본 `AppModule`과 `apps/api/src/main.ts`에는 자동 연결하지 않았다. 실제 provider adapter와 등록값이 아직 준비되지 않은 runtime gate다. 현재 `pnpm --filter @ldb/api start`는 기존 runtime-only app이며 이 PR만으로 배포된 `/auth/*`가 활성화되지 않는다. HTTP 검증은 별도 factory에 격리 test 설정을 주입해 수행한다. 제품용 test mode·환경변수 인증 우회·HTTP verified identity 입력은 없다.

실제 연결 전에 다음 값을 운영 담당이 제공·검증해야 한다. 이 구현은 실제 값을 정하거나 파일·환경변수·외부 계정에 등록하지 않는다.

- 초기화된 DB와 `logging:false`, `synchronize:false`, `migrationsRun:false`. 기존 `DatabaseModule.register`/DataSource 설정을 사용한다.
- 실제 provider adapter와 exact registry: API HTTPS origin, provider client ID·secret 설정 참조·HTTPS callback·authorization endpoint·configuration version, Google audience, 등록 protocol/host/path와 return target version.
- DB 밖 provider AES-256-GCM key와 retained decrypt key, 별도의 JWT key/issuer/audience. Key와 registry는 listen 전에 검증한다. JWT issuer는 기존 `createAccessJwtIssuer`의 검증·발급을 재사용한다.
- `createLoginHttpApp`의 `bodyParser:false`, 정제 오류·무원문 logging 경계를 유지한 실제 server composition. 운영 proxy/APM/browser의 수집 차단은 별도 검증한다.

## Source pointer

| File | 책임 |
| --- | --- |
| `apps/api/src/constants/login.ts`, `apps/api/src/types/login.ts`, `apps/api/src/errors/login.ts` | 승인된 값·내부 입력/출력·정제 오류 |
| `apps/api/src/auth/login/crypto.ts` | Canonical 32-byte proof/code, S256, decoded-byte hash, provider PKCE 암호화 |
| `apps/api/src/auth/login/registry.ts` | 설정 검증·복제·불변 snapshot과 historical version 조회 |
| `apps/api/src/auth/login/input.ts` | JSON field/domain 및 OAuth callback parameter 검증 |
| `apps/api/src/auth/login/state.ts` | READ COMMITTED transaction, fresh DB clock, terminal 정리, cookie binding |
| `apps/api/src/auth/login/start.ts` | 요청 생성·launch ticket 단일 소비·authorization redirect 준비 |
| `apps/api/src/auth/login/callback.ts` | Callback claim·외부 검증 deadline·검증 결과와 exchange-ready commit |
| `apps/api/src/auth/login/exchange.ts` | Proof/TTL 재검증·기존 identity-session/JWT 합성 |
| `apps/api/src/auth/login/service.ts` | 내부 dependency 연결과 service 생성 |
| `apps/api/src/auth/login/json-parser.ts`, `http.ts` | 실제 stream parser, Nest route, no-store·정적 HTML·오류 경계 |

## Google adapter 연결점

`LoginDependencies.verifyProvider(ProviderVerificationInput)`만 서버의 검증 완료 identity를 반환한다. 입력은 저장된 `snapshot`, provider `code`, 복호화한 별도 `providerVerifier`, Google `nonceHash`, 단일 deadline의 `AbortSignal`이다. Public request의 provider/subject를 이 결과로 바꾸는 경로는 없다.

Google 후속 adapter는 이 snapshot의 client/secret 참조·callback을 사용해 token을 교환하고, `auth-oauth.md`의 signature·issuer·audience/azp·시간·nonce·subject·at_hash와 trusted JWKS를 검증한다. 전체 token/identity/JWKS 처리는 전달된 signal 안에서 끝나야 하며 자동 retry는 없다. Name/email/photo와 외부 token을 반환·DB 저장하지 않고 `{provider,subject}`만 수용 경계로 돌려준다. 실제 provider HTTP 구현과 credential E2E는 이번 산출물에 없다.

Authorization URL의 Google `openid profile`, Discord `identify`, 독립 S256은 공통 등록/상태 처리에서 구성한다. Discord adapter는 완료된 #57 조사와 별도로 남은 일반 confidential OAuth PKCE gate를 해소하기 전 제품에 연결하지 않는다. 격리 fixture에서 Discord 상태를 검증해도 실제 provider enforcement evidence가 되지 않는다.

## Transaction과 복구

- 요청 생성은 transient row만 쓴다. Launch는 hash로 row를 잠가 한 번 소비하고 browser cookie·state·Google nonce·암호화 provider proof를 연결한다.
- Callback은 browser/provider/TTL을 확인해 `processing`을 commit한 뒤 외부 verifier를 호출한다. Provider 처리가 멈춘 동안 별도 connection에서 해당 row의 `FOR UPDATE NOWAIT`가 성공한다. Claim commit 지연을 포함한 단일 10초 deadline으로 제한하며 늦은 결과는 무시한다.
- 검증 완료 시각을 먼저 고정해 code TTL이 이후 row lock 대기로 연장되지 않게 한다. Exchange-ready commit에서는 더 이상 필요 없는 browser/provider proof도 정리하고 앱 proof·subject·code hash·deadline만 남긴다.
- Exchange는 OAuth row→user→새 session→refresh 순서의 하나의 transaction을 사용한다. User/identity uniqueness 대기 및 JWT 준비 뒤에도 fresh DB 정수 초로 TTL을 재확인한다. TTL을 넘으면 준비한 회원/session 쓰기를 rollback하고 별도 짧은 transaction에서 만료 row를 정리한다.
- `createIdentitySession`과 JWT issuer의 반환은 commit 전 임시 값이다. `loginTransaction`이 commit 성공을 확인한 뒤에만 HTTP에 전달한다. Commit 결과 불명은 정제된 503이며 response/token cache, 자동 retry, 재전달 grace가 없다. 실제 commit됐다면 replay는 400이다.
- 취소·provider 실패·유효한 만료 read는 terminal commit에서 민감 field를 null 처리한다. Crash/DB 장애 뒤 남은 row의 물리 삭제는 별도 cleanup/운영 범위다. Cleanup 미구현이 TTL 뒤 교환을 허용하지 않는다.

## HTTP·노출 검증

Pre-parser는 media/encoding을 먼저 확인하고 실제 payload를 최대 16,384 byte만 buffer한다. Chunked body의 종료를 기다리지 않고 초과 시 413과 connection close를 반환한다. 전체 body가 상한 이하면 strict UTF-8·JSON·정확한 field를 검증한다. 선언된 Content-Length 초과는 조기 거절하고, 상충한 Content-Length/Transfer-Encoding 같은 HTTP framing 오류는 Node의 선행 거절로 구분한다. Framing 밖 bytes를 제품 JSON body로 재해석하지 않는다.

모든 factory 응답은 no-store이며 browser 응답은 no-referrer와 active content/frame을 차단하는 CSP를 사용한다. 완료 HTML에는 등록 return URL의 자체 code만 둔다. Nest logger와 TypeORM raw logging을 끄고 오류 객체·URL·body·cookie·credential·identity를 출력하지 않는다. 별도 API process에서 stdout/stderr와 canary 요청을 검증한다. 실제 proxy/APM/OS history 수집 차단을 이 test로 대신하지 않는다.

## Validation

표준 command는 repository root에서 실행한다.

```bash
pnpm --filter @ldb/api run --sequential '/^(build|lint|test|typecheck)$/'
pnpm --filter @ldb/api test:database
git diff --check
```

- `apps/api/test-support/login-primitives.test.mjs`: encoding·hash 입력 차이·정확한 field·callback parameter·registry·PKCE key/AAD.
- `login-http.test.mjs`, `login-log-probe.mjs`: 실제 HTTP stream 상한·우선순위·HTML·redirect·정제 오류와 별도 process log sink.
- `login-state.test.mjs`: commit 결과 불명 뒤 만료 processing/active read의 terminal 정리 regression.
- `login-database.mjs`: 실제 상태 흐름·회원 쓰기 0·잘못된 proof·replay·기존 identity와 독립 session·서명 실패 rollback.
- `login-concurrency.mjs`, `login-test-control.mjs`: 실제 PostgreSQL blocker를 관측한 ticket/exchange/identity 경합, provider 동안 lock 해제, OAuth/user lock 뒤 fresh time, 정확 만료, code TTL cap, callback timeout. 정확한 경계 equality는 실제 SQL/row lock과 함께 test에서 clock 결과를 고정하며, 잠금 대기의 만료는 실제 DB clock으로 별도 검증한다. 두 번째 waiter가 첫 waiter의 tuple lock 뒤에 대기하는 경우도 실제 blocker로 확인한다.
- `login-failures.mjs`: 실제 consumed UPDATE 뒤 rollback, commit 전 실패/commit 성공 뒤 응답 유실, callback claim/완료 응답 유실, snapshot/key 변경과 비자격 요청의 무변경.
- `login-http-integration.mjs`: Nest HTTP→실제 PostgreSQL→실제 JWT issuer의 전체 흐름. Commit 확인 전 HTTP 응답 없음과 commit 불명 뒤 token 미전달도 검증한다.

DB helper는 기존 Docker-only disposable harness에 연결된다. 기존 Migration/catalog·constraint·schema drift·데이터 보존·exact resource teardown도 함께 수행한다. 실제 실행은 native `linux/arm64/v8` PostgreSQL 18.6이며 `linux/amd64`, 실제 provider/credential, Desktop·browser/OS protocol·저장소, 운영 배포·clock 동기화·proxy/APM·cleanup은 미검증이다. 최종 command 결과와 AC별 evidence는 Issue #63 및 연결 Draft PR을 따른다.
