---
type: reference
scope: apps/api common login and Google provider implementation
last-reviewed: 2026-09-06
---

# 공통 로그인 구현과 연결

`apps/api/src/auth/login`은 승인된 로그인 요청·browser/provider binding·callback claim·일회용 exchange를 구현한다. Canonical contract는 `docs/rules/auth-api.md`, `auth-oauth.md`, `auth-session.md`, `auth-database.md`, `auth-runtime.md`다. 이 Reference는 현재 구현 위치와 검증·연결 경계만 설명한다.

## 현재 실행 경계

`createLoginService`에 초기화된 DataSource, 검증된 registry와 provider PKCE key, 실제 Access JWT issuer, 서버의 provider verifier를 주입한다. `createLoginHttpApp(service)`는 이 service를 실제 Nest HTTP route에 연결하며 기본 body parser를 끄고 인증 pre-parser와 정제 오류 처리를 설치한다. DataSource는 composition 호출자가 소유하고 종료한다.

`apps/api/src/app.ts`의 기본 `AppModule`과 `apps/api/src/main.ts`에는 자동 연결하지 않았다. Google adapter는 구현했지만 실제 registry·secret resolver·운영 composition의 제공과 검증이 남아 있다. 현재 `pnpm --filter @ldb/api start`는 기존 runtime-only app이며 배포된 `/auth/*`가 활성화되지 않는다. HTTP 검증은 별도 factory에 격리 test 설정을 주입해 수행한다. 제품용 test mode·환경변수 인증 우회·HTTP verified identity 입력은 없다.

실제 연결 전에 다음 값을 운영 담당이 제공·검증해야 한다. 이 구현은 실제 값을 정하거나 파일·환경변수·외부 계정에 등록하지 않는다.

- 초기화된 DB와 `logging:false`, `synchronize:false`, `migrationsRun:false`. 기존 `DatabaseModule.register`/DataSource 설정을 사용한다.
- Exact registry와 provider 연결: API HTTPS origin, provider client ID·secret 설정 참조·HTTPS callback·authorization endpoint·configuration version, Google audience, 등록 protocol/host/path와 return target version. Google은 아래 factory와 서버가 신뢰하는 token/JWKS endpoint 및 historical secret resolver를 연결한다.
- DB 밖 provider AES-256-GCM key와 retained decrypt key, 별도의 JWT key/issuer/audience. Key와 registry는 listen 전에 검증한다. JWT issuer는 기존 `createAccessJwtIssuer`의 검증·발급을 재사용한다.
- `createLoginHttpApp`의 `bodyParser:false`, 정제 오류·무원문 logging 경계를 유지한 실제 server composition. 운영 proxy/APM/browser의 수집 차단은 별도 검증한다.

## Source pointer

| File | 책임 |
| --- | --- |
| `apps/api/src/constants/login.ts`, `apps/api/src/types/login.ts`, `apps/api/src/errors/login.ts` | 승인된 값·내부 입력/출력·정제 오류 |
| `apps/api/src/auth/login/crypto.ts` | Canonical 32-byte proof/code, S256, decoded-byte hash, provider PKCE 암호화 |
| `apps/api/src/auth/login/registry.ts` | 설정 검증·복제·불변 snapshot과 historical version 조회 |
| `apps/api/src/auth/login/input.ts` | JSON field/domain 및 OAuth callback parameter 검증 |
| `apps/api/src/auth/login/state.ts` | 단순 READ COMMITTED transaction 오류 정제, fresh DB clock, 명시적 실패 정리, cookie binding |
| `apps/api/src/auth/login/start.ts` | 요청 생성·launch ticket 단일 소비·authorization redirect 준비 |
| `apps/api/src/auth/login/callback.ts` | Callback claim·외부 검증 deadline·검증 결과와 exchange-ready commit |
| `apps/api/src/auth/login/exchange.ts` | Proof/TTL 재검증·기존 identity-session/JWT 합성 |
| `apps/api/src/auth/login/service.ts` | 내부 dependency 연결과 service 생성 |
| `apps/api/src/auth/login/json-parser.ts`, `http.ts` | 실제 stream parser, Nest route, no-store·정적 HTML·오류 경계 |
| `apps/api/src/auth/google/types.ts`, `index.ts` | Server-only 설정·historical snapshot binding·Google RS256/claim 검증·최소 identity 반환 |
| `apps/api/src/auth/google/transport.ts` | Secret 해석·code 교환·body 읽기의 공통 signal 적용과 민감 참조 정리 |
| `apps/api/src/auth/google/jwks.ts` | Trusted URL의 public JWK cache·회전과 bounded unknown kid refresh; key 선택은 jose |

## Google adapter 연결점

`LoginDependencies.verifyProvider(ProviderVerificationInput)`만 서버의 검증 완료 identity를 반환한다. 입력은 저장된 `snapshot`, provider `code`, 복호화한 별도 `providerVerifier`, Google `nonceHash`, 단일 deadline의 `AbortSignal`이다. Public request의 provider/subject를 이 결과로 바꾸는 경로는 없다.

`createGoogleProviderVerifier(configuration)`의 반환 함수를 `verifyProvider`에 주입한다. `configuration.registrations`는 서버가 신뢰하는 allowlist이며 각 항목은 공통 `snapshot`, `tokenEndpoint`, `jwksUri`를 가진다. Factory는 공통 registry 검증·복제·불변 snapshot을 재사용하고 URL의 exact HTTPS·userinfo/query/fragment 부재를 검사한다. 이 syntactic 검사는 arbitrary HTTPS host를 Google 소유로 인증하지 않는다. 실제 Google endpoint 선택과 registry 배포는 trusted server composition의 책임이며 public request나 token header로 설정하지 않는다.

`resolveSecret({version,reference,signal})`은 저장 snapshot의 version과 secret 참조만 해석한다. Factory는 resolver와 registration의 설정 형식을 listen 전에 검증하지만 실제 secret 저장소의 availability를 미리 확인하지 않는다. Callback에서 secret 해석이 실패하거나 historical version을 제공할 수 없으면 정제 provider 실패이며 active secret으로 대체하지 않는다. File·환경변수·외부 secret manager 중 무엇을 사용할지, 실제 값과 운영 availability 점검 절차는 이 구현이 정하지 않는다.

Adapter는 snapshot의 client/secret 참조·callback으로 token을 한 번 교환한다. 승인된 `jose 6.2.12`가 Google RS256 signature·issuer·필수 claim·exp를 검증하며 adapter가 scalar exact aud/azp, iat, ASCII·case-sensitive·최대 255자 sub, transaction nonce와 선택적 at_hash를 추가 확인한다. Nonce는 공통 `opaqueHash`의 canonical base64url decoded 32-byte SHA-256을 재사용하고 PKCE의 ASCII S256과 구분한다. Name/email/photo·예상치 않은 refresh token·원문 응답은 전달하지 않고 `{provider,subject}`만 반환한다. 자체 ES256 JWT의 key/issuer/audience와 공유하지 않는다.

Token과 JWKS HTTP는 `redirect:error`이며 token의 `jku`/`x5u`를 해석하지 않는다. JWKS response의 public RSA field와 jose local resolver만 cache에 남긴다. `Cache-Control: max-age`와 `Age`를 적용하고 no-store/no-cache·수명 없음/만료는 재사용하지 않는다. Unknown kid는 cache 상태와 무관하게 한 번 refresh하고 여전히 없으면 실패한다. Cold/expired cache는 최초 fetch 뒤 추가 refresh 한 번으로 최대 두 번의 JWKS 요청을 수행한다. 이는 새 key 전파를 확인하는 bounded refresh이며 token 교환이나 실패한 network 요청의 자동 retry가 아니다. 동시 fetch의 늦은 이전 응답이 새 cache를 덮어쓰지 않으며 취소된 fetch의 결과를 cache에 넣지 않는다.

공통 callback이 소유한 단일 10초 deadline의 동일 signal을 secret 해석·token headers/body·JWKS headers/body·비동기 key/signature 처리에 적용한다. 별도 단계 timer나 자동 retry는 없다. 취소를 무시하는 주입 transport의 늦은 응답도 수용하지 않고 body를 취소한다. Code/verifier/client secret의 form과 참조는 token headers 수신 또는 실패 시 정리하고 raw response/ID/access token 참조는 검증 종료·실패·취소의 finally에서 해제한다. Native fetch/WebCrypto 내부 처리의 즉각 종료나 JS string zeroization·GC 시점은 보장하지 않는다.

내부 입력 형식·범위·검증 실패는 `TypeError`/`RangeError`/`Error`의 고정 비민감 reason으로 구분한다. 외부 반환은 기존 `LoginFailure`로 정제하고 원문 값·내부 reason·cause를 노출하지 않는다. Response object와 ID token 유무 검사는 의미를 나타내는 조건 이름으로 분리하며 검증용 원문 alias는 JWKS 대기 전에 scope를 끝낸다.

Authorization URL의 Google `openid profile`, Discord `identify`, 독립 S256은 공통 등록/상태 처리에서 구성한다. Discord adapter는 완료된 #57 조사와 별도로 남은 일반 confidential OAuth PKCE gate를 해소하기 전 제품에 연결하지 않는다. 격리 fixture에서 Discord 상태를 검증해도 실제 provider enforcement evidence가 되지 않는다.

## Transaction과 복구

- 요청 생성은 transient row만 쓴다. Launch는 hash로 row를 잠가 한 번 소비하고 browser cookie·state·Google nonce·암호화 provider proof를 연결한다.
- Callback은 browser/provider/TTL을 확인해 `processing`을 commit한 뒤 외부 verifier를 호출한다. Provider 처리가 멈춘 동안 별도 connection에서 해당 row의 `FOR UPDATE NOWAIT`가 성공한다. Claim commit 지연을 포함한 단일 10초 deadline으로 제한하며 늦은 결과는 무시한다.
- Provider 검증의 `finally`에서 claim이 보유한 raw provider code와 복호화한 verifier 참조를 함께 해제한다. 성공 저장 또는 실패 정리의 후속 DB 대기 전에 수행하며 JS string의 즉각 zeroization이나 GC 시점은 보장하지 않는다.
- 검증 완료 시각을 먼저 고정해 code TTL이 이후 row lock 대기로 연장되지 않게 한다. Exchange-ready commit에서는 더 이상 필요 없는 browser/provider proof도 정리하고 앱 proof·subject·code hash·deadline만 남긴다.
- Exchange는 OAuth row→user→새 session→refresh 순서의 하나의 transaction을 사용한다. User/identity uniqueness 대기 및 JWT 준비 뒤에도 fresh DB 정수 초로 TTL을 재확인한다. TTL을 넘으면 준비한 회원/session 쓰기를 rollback하고 별도 짧은 transaction에서 만료 row를 정리한다.
- `createIdentitySession`과 JWT issuer의 반환은 commit 전 임시 값이다. Authorize·callback claim/완료·exchange는 `DataSource.transaction`의 commit·release 완료 뒤 각 함수에서 명시적인 결과를 확인한다. 성공 결과만 다음 단계 또는 HTTP에 전달하고, `rejected`는 요청 정리를 commit한 뒤 오류를 던진다. Transaction 안에서 던진 오류는 DB 쓰기를 rollback한다. 요청 생성과 별도 실패 정리는 단순 transaction 오류를 정제하는 `loginTransaction`을 사용한다. Commit 결과 불명은 정제된 503이며 response/token cache, 자동 retry, 재전달 grace가 없다. 실제 commit됐다면 replay는 400이다.
- 취소·provider 실패·유효한 만료 read는 terminal commit에서 민감 field를 null 처리한다. Crash/DB 장애 뒤 남은 row의 물리 삭제는 별도 cleanup/운영 범위다. Cleanup 미구현이 TTL 뒤 교환을 허용하지 않는다.

## HTTP·노출 검증

Pre-parser는 media/encoding을 먼저 확인하고 실제 payload를 최대 16,384 byte만 buffer한다. Chunked body의 종료를 기다리지 않고 초과 시 413과 connection close를 반환한다. 전체 body가 상한 이하면 strict UTF-8·JSON·정확한 field를 검증한다. 선언된 Content-Length 초과는 조기 거절하고, 상충한 Content-Length/Transfer-Encoding 같은 HTTP framing 오류는 Node의 선행 거절로 구분한다. Framing 밖 bytes를 제품 JSON body로 재해석하지 않는다.

Controller와 직접 호출 가능한 service는 각각 입력을 검증한다. Service 내부 callback은 한 번 parsing한 성공/code 또는 실패/error 입력을 claim 단계로 전달하며, claim이 성공한 결과만 provider code를 보유한 검증 입력으로 사용한다.

Authorize와 Google/Discord callback handler는 GET만 service로 전달한다. Express가 GET handler로 넘기는 HEAD는 query 검증·ticket 소비·callback claim 전에 `400 LOGIN_REQUEST_INVALID`로 거절한다. HEAD의 응답 body는 비어 있고 cookie·redirect를 발급하지 않으며, 같은 ticket/state/cookie를 이후 GET에서 사용할 수 있다.

모든 factory 응답은 no-store이며 browser 응답은 no-referrer와 active content/frame을 차단하는 CSP를 사용한다. 완료 HTML에는 등록 return URL의 자체 code만 둔다. Nest logger와 TypeORM raw logging을 끄고 오류 객체·URL·body·cookie·credential·identity를 출력하지 않는다. 별도 API process에서 stdout/stderr와 canary 요청을 검증한다. 실제 proxy/APM/OS history 수집 차단을 이 test로 대신하지 않는다.

## Validation

표준 command는 repository root에서 실행한다.

```bash
pnpm --filter @ldb/api run --sequential '/^(lint|test|typecheck)$/'
pnpm --filter @ldb/api test:database
git diff --check
```

`test`는 `build`를 먼저 실행하므로 dist가 없거나 오래된 상태에서도 최신 source를 검증한다.

- `apps/api/test-support/login-primitives.test.mjs`: encoding·hash 입력 차이·정확한 field·callback parameter·registry·PKCE key/AAD.
- `login-http.test.mjs`, `login-log-probe.mjs`: 실제 HTTP stream 상한·우선순위·HTML·redirect·정제 오류와 별도 process log sink.
- `login-state.test.mjs`: commit 결과 불명 뒤 만료 processing/active read의 terminal 정리, provider 검증 성공·예외·잘못된 identity·timeout 뒤 DB 대기 전 claim의 code/verifier 참조 해제 regression. Transaction test double에서 claim 결과를 관측하고 후속 transaction을 보류하며, timeout은 test timer로 구동한다.
- `login-database.mjs`: 실제 상태 흐름·회원 쓰기 0·잘못된 proof·replay·기존 identity와 독립 session·서명 실패 rollback.
- `login-concurrency.mjs`, `login-test-control.mjs`: 실제 PostgreSQL blocker를 관측한 ticket/exchange/identity 경합, provider 동안 lock 해제, OAuth/user lock 뒤 fresh time, 정확 만료, code TTL cap, callback timeout. 정확한 경계 equality는 실제 SQL/row lock과 함께 test에서 clock 결과를 고정하며, 잠금 대기의 만료는 실제 DB clock으로 별도 검증한다. 두 번째 waiter가 첫 waiter의 tuple lock 뒤에 대기하는 경우도 실제 blocker로 확인한다.
- `login-failures.mjs`: 실제 consumed UPDATE 뒤 rollback, commit 전 실패/commit 성공 뒤 응답 유실, callback claim/완료 응답 유실, snapshot/key 변경과 비자격 요청의 무변경.
- `login-http-integration.mjs`: Nest HTTP→실제 PostgreSQL→실제 JWT issuer의 전체 흐름. Commit 확인 전 HTTP 응답 없음과 commit 불명 뒤 token 미전달, HEAD 전후 요청 row 전체·provider 호출·회원/session 무변경과 후속 GET/exchange 성공도 검증한다.
- `google-identity.test.mjs`, `google-fixtures.mjs`: 매 run synthetic key로 실제 RS256 서명·거절, canonical nonce/at_hash, issuer·scalar aud/azp·시간·subject와 최소 반환 identity. 실제 계정이나 고정 private key를 사용하지 않는다.
- `google-transport.test.mjs`: Historical client/secret/callback/audience·trusted endpoint binding, cache freshness/expiry·회전·unknown kid, secret/token/JWKS의 취소·늦은 응답·cache 오염 방지·정제 오류·form 참조 정리. Cold/expired JWKS의 두 번째 응답에만 있는 실제 RS256 key 수용과 unknown kid의 최대 두 fetch, refresh 중 동일 signal 취소·늦은 응답·network 오류 무재시도도 검증한다.
- `google-http-integration.mjs`: 실제 adapter와 disposable loopback provider HTTP를 Nest→Docker PostgreSQL→실제 자체 JWT에 연결한다. 실제 RS256 성공·signature/nonce/HTTP 실패, callback 중복 교환 방지·provider 동안 row lock 해제, exchange 동시 단일 소비·기존 identity와 독립 session·다른 session/refresh 원문 row 보존·JWT 실패 rollback, token 대기 뒤 JWKS까지 동일한 실제 10초 deadline과 늦은 응답을 검증한다. 성공·실패·timeout 동안 API process stdout/stderr를 직접 capture하여 비노출을 확인하며 raw provider token과 응답이 DB/HTTP에 없는지 확인한다.

DB helper는 기존 Docker-only disposable harness에 연결된다. 기존 Migration/catalog·constraint·schema drift·데이터 보존·exact resource teardown과 merge된 내부 [refresh core 검증](auth-refresh-development.md)을 함께 보존한다. 실제 실행은 native `linux/arm64/v8` PostgreSQL 18.6이며 `linux/amd64`, 실제 Google endpoint/credential·계정, Desktop·browser/OS protocol·저장소, 운영 배포·secret 저장소·clock 동기화·proxy/APM·cleanup은 미검증이다. 격리 통과는 실제 Google 로그인 또는 배포 완료를 뜻하지 않는다. 공통 흐름 evidence는 Issue #63, Google 연결의 최종 command 결과·AC별 evidence·후속 실제 환경 gate는 Issue #68과 연결 PR을 따른다.
