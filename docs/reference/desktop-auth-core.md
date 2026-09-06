---
type: reference
status: active
scope: apps/desktop main authentication core
last-reviewed: 2026-09-06
---

# Desktop Auth Core

Desktop main 인증의 현재 독립 core는 `apps/desktop/src/backend/auth`에 있다. 이 구현은 승인된 `docs/rules/desktop-auth.md`, `docs/rules/desktop-auth-lifecycle.md`, `docs/rules/desktop-auth-platform.md`를 소비한다. `apps/desktop/src/backend/main.ts` bootstrap, protocol/IPC/UI, 실제 `safeStorage`·file adapter에는 아직 연결되지 않았다.

## Module 경계

| Path                                                     | 현재 책임                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/backend/auth/coordinator.ts`           | 단일 auth state, pending login, generation, credential writer, restore·refresh·logout과 공개 snapshot 전이 |
| `apps/desktop/src/backend/auth/types.ts`                 | main 내부 effect와 snapshot·명령 결과 type                                                                 |
| `apps/desktop/src/backend/auth/pkce.ts`                  | 32-byte verifier와 ASCII S256 challenge 생성, canonical base64url 검사                                     |
| `apps/desktop/src/backend/auth/protocol.ts`              | trusted HTTPS API origin, browser launch URL, 등록 return target과 code-only 복귀 URL 검사                 |
| `apps/desktop/src/backend/auth/http.ts`                  | 고정 auth endpoint request, caller abort와 15초 deadline                                                   |
| `apps/desktop/src/backend/auth/http-response.ts`         | 16,384-byte strict UTF-8 JSON stream과 endpoint별 exact response/error 검사                                |
| `apps/desktop/src/backend/auth/credential-operations.ts` | durable transition 확립, credential commit, marker 제거·재확립, local clear 결과 합성                      |

Coordinator 생성 시 enabled provider, API origin, 등록 return target과 Browser·HTTP·clock·entropy·credential store effect를 주입한다. Source에는 운영 origin, owned scheme, app identity가 없다. Composition은 같은 trusted runtime config로 고정 HTTP client와 coordinator를 만들고 실제 platform adapter를 연결해야 한다.

## Credential store effect 계약

Store adapter는 `inspect`, `establishTransition`, `commitCredential`, `clearCredential`, `removeTransition`, `reestablishTransition`을 구현한다. Mutation은 `confirmed`, `failed`, `unknown`을 구분한다. Core가 이 결과를 다음처럼 공개 상태에 반영한다.

- `ready` inspection의 refresh만 restore 후보로 사용한다. `unavailable`은 임의 clear 없이 `storageBlocked/SECURE_STORAGE_UNAVAILABLE`이다.
- `recovery-required`는 refresh를 보내지 않고 clear 순서를 실행한다. Clear 전체가 확인되면 `signedOut/REAUTH_REQUIRED`, 확인되지 않으면 `storageBlocked/LOCAL_CLEAR_UNCONFIRMED`다.
- Exchange와 refresh는 transition 확정 뒤에만 HTTP를 보낸다. 새 credential commit과 marker 제거가 모두 확인된 뒤에만 로그인 또는 refresh 성공을 공개한다.
- Exchange는 marker 준비, HTTP 완료, credential commit과 marker finalize 경계에서 pending generation과 fresh clock을 다시 확인한다. Finalize 전 invalidation이면 marker를 유지한다. Finalize 대기 중 만료·불연속·취소로 invalidation됐고 marker가 제거됐다면 durable marker를 재확립한 뒤 known refresh 폐기와 clear로 이동한다. 재확립 실패는 `LOCAL_CLEAR_UNCONFIRMED`로 처리하며 재시작 복원 차단을 보장하지 않는다. 명시 logout이 진행 중이면 해당 logout이 최종 local cleanup과 결과 공개를 소유한다.
- Marker 제거 결과가 불명확하면 marker를 다시 확립한다. 재확립이 확인되면 자동 restore 차단을 유지하며 `TOKEN_SAVE_FAILED`, 재확립도 불명확하면 `LOCAL_CLEAR_UNCONFIRMED`를 우선한다.
- Local clear는 clear transition, credential 삭제, marker 제거가 모두 확인돼야 clean이다. 서버 logout 결과와 독립적으로 판단한다.

실제 adapter는 platform Rule의 safeStorage, atomic replacement, file/directory durability, ownership·symlink·permission 검사를 별도 구현해야 한다. 현재 mock의 `confirmed`는 native durability evidence가 아니다.

## Lifecycle entry

- `start()`는 store를 한 번 복원한다. Ready refresh를 transition 뒤 한 번 rotate하고 새 credential을 commit한 다음 `GET /me`로 user를 확인해야 `signedIn/home`이 된다.
- `beginLogin(provider)`는 `signedOut`이고 이전 writer가 끝난 때만 local attempt와 독립 PKCE를 만든다. 검증한 login request 응답만 외부 Browser에 한 번 전달한다.
- `handleReturnUrl(raw)`은 exact registered target과 canonical code만 처리한다. 현재 pending을 동기적으로 claim하고 duplicate는 같은 작업에 합류하며 다른 in-flight code와 최근 거절 code는 재전송하지 않는다.
- `cancelLogin(attemptId)`과 pending expiry는 generation을 먼저 바꾸고 pending을 폐기한다. 늦은 token 응답은 publish·commit하지 않고 known refresh의 서버 폐기와 local clear를 시도한다.
- `authorization()`은 main 내부 보호 기능용이다. 유효 access와 현재 generation을 반환하거나 session별 refresh single-flight 결과를 공유한다. Logout·인증 상실로 generation이 바뀌면 늦은 refresh 결과는 사용할 수 없는 결과가 된다.
- 전송됐을 수 있는 refresh가 401, network/timeout, 5xx 또는 malformed response로 끝나면 같은 R0를 다시 쓰지 않는다. Durable marker 아래에서 known R0의 서버 logout을 한 번 시도하고 local clear로 재로그인 상태를 확정한다.
- `retryAuth()`는 `restorePaused`의 현재 단계 또는 `storageBlocked`의 inspection/cleanup만 재개한다. 불명확한 exchange code나 전송됐을 수 있는 refresh를 다시 보내지 않는다.
- `logout()`은 동시 호출이 결과를 공유한다. Idle session은 durable clear marker를 먼저 확인한 뒤 서버 logout을 보낸다. Refresh HTTP가 이미 시작됐다면 기존 transition marker 아래에서 알고 있는 refresh로 서버 logout을 즉시 시작하고 writer 종료 뒤 clear marker로 교체한다. Marker 준비 전 writer는 무효화·종료하고 clear marker를 먼저 만든다. Local clear 불명은 `LOCAL_CLEAR_UNCONFIRMED`, local clear 성공과 서버 결과 불명은 `LOGOUT_SERVER_UNCONFIRMED`다.

`getSnapshot()`과 `subscribe()`가 반환하는 값은 `runId`, `revision`, `phase`, `providers`, local login 안내, nickname, entry, notice allowlist뿐이다. Refresh/access, verifier, exchange code, server request/user identity와 raw error는 포함하지 않는다.

## HTTP와 검증 범위

`createAuthHttpClient`는 주입된 exact HTTPS origin에서 `/auth/login-requests`, `/auth/exchange`, `/auth/refresh`, `/auth/logout`, `/me`만 호출한다. Request는 redirect error, no-store, credential omit를 사용한다. 이미 취소된 signal은 fetch 전에 거절하고, response header부터 body 완료까지 같은 15초 deadline을 적용한다.

Success와 정제 error body는 field 수·name·type까지 검사한다. Access는 크기 제한을 둔 compact JWS 형태, refresh/code는 canonical 32-byte base64url, ID는 UUID, 시간은 UTC ISO, nickname은 well-formed string인지 확인한다. JWT claim이나 server identity는 해석하지 않는다.

Unit test는 Browser·HTTP·clock과 credential/marker 상태를 가진 store fake를 제어해 PKCE, URL, response stream, pending 취소·만료, duplicate/stale 복귀, commit 전 비공개, marker 결과와 재시작 recovery, restore와 `GET /me`, refresh single-flight, logout 경합과 snapshot 비노출을 확인한다. 실제 API `GET /me`, native credential store, OS protocol, Browser/provider, packaged app, IPC/UI/capture 연결은 후속 gate다.
