---
type: rule
status: active
enforcement: approval-required
scope: apps/api OAuth login transaction
last-reviewed: 2026-09-05
rationale: 공개 Desktop client와 browser·provider callback의 연결 및 일회용 소비를 명시한다.
evidence: "PR #48 사용자 승인: https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519 ; entropy 보완 추가 승인: https://github.com/blahaj94/ldb/pull/48#issuecomment-5551875298 ; 설계 근거: Issue #39 Proposal Revision 2 https://github.com/blahaj94/ldb/issues/39#issuecomment-5551313691"
exceptions: 사용자 구현 금지 조건을 유지하며 Discord 일반 OAuth PKCE·실제 등록값은 별도 gate다.
review-after: 실제 provider flow의 최초 검증 또는 provider 규격 변경 시
---

# OAuth Login Contract

이 문서는 [PR #48의 사용자 승인](https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519)을 반영한 Rule이다. 현재 구현·검증 성공을 뜻하지 않으며 미결정 gate 유지와 구현 금지 조건을 따른다. HTTP/노출 경계는 [`auth-api.md`](auth-api.md), transient schema·정리는 [`auth-database.md`](auth-database.md), 실행 gate는 [`auth-runtime.md`](auth-runtime.md)를 따른다. Provider별 identity는 `provider+subject`이고 Google/Discord는 같은 email 여부와 무관하게 별도 계정이다. 이름·email·사진은 영구 보관하지 않는다.

아래 Exchange code entropy 보완절은 기존 8개 Rule 승인과 별도로 [추가 승인](https://github.com/blahaj94/ldb/pull/48#issuecomment-5551875298)을 받았다. 기존 승인과 보완절의 승인 근거를 구분한다.

## Proof와 등록 snapshot

앱은 매 로그인 독립적인 32-byte CSPRNG verifier를 canonical base64url(43자, padding 없음)로 생성·보관한다. `codeChallenge=BASE64URL(SHA256(ASCII(codeVerifier)))`이며 S256만 허용한다. 비canonical 인코딩·plain을 거절하고 요청 사이 verifier를 재사용하지 않는다. 앱 재시작으로 verifier를 잃으면 새 로그인한다. 자체 교환 구간에 [RFC 7636 S256](https://www.rfc-editor.org/rfc/rfc7636.html)을 적용한 프로젝트 정책이다.

API는 request UUID·32 random byte launch ticket을 만들고 ticket hash·challenge·provider·등록 client/return target·생성/만료 시각을 저장한다. 요청자는 redirectUri/URL을 지정하지 않는다. 정적 server registry는 자체 client `desktop` 한 행에 provider별 다음 exact tuple을 가진다.

- Provider, provider OAuth client ID, secret 설정 참조, HTTPS callback
- Google expected audience, return target의 protocol/host/path, configuration version

Secret 값은 request row에 저장하지 않는다. Request는 provider configuration과 return target version에 고정되고 callback·token 교환·ID Token audience·앱 exchange가 같은 snapshot을 사용한다. 처리 중 새 registry 값으로 재해석하지 않는다. 과거 설정을 지원할 수 없으면 pending request를 실패 처리한다. Wildcard·prefix match·미등록 URI·user info·fragment는 금지하며 실제 값은 별도 운영/플랫폼 gate다.

Registry는 arbitrary redirect/SSRF 경계이며 public clientId/challenge가 공식 앱 설치를 증명하지 않는다. 인증 전 공개 endpoint의 abuse 수치·운영 한도는 미정이고 검색 account quota를 로그인 전에 적용하지 않는다.

## 상태 전이와 시간

Request 전체 TTL은 생성부터 최대 **600초**다. 정확한 만료에서 거절하며 lock 대기 뒤에도 fresh 서버 시각으로 재확인한다. Provider 처리로 연장하지 않는다.

1. `created → browser_started`: launch ticket을 원자적으로 한 번 소비하고 browser binding·provider state·Google OIDC nonce hash와 별도 provider PKCE proof를 연결한다. Browser nonce와 state는 각각 독립 32 random byte다. Cookie 이름은 요청별 `__Host-ldb-login-<requestId>`이며 Secure·HttpOnly·SameSite=Lax·Path=/·Domain 없음·최대 600초다.
2. Callback은 provider route/저장 provider 일치, state·cookie·TTL·상태를 검증한다. `state/code/error` 중복, state 누락/불일치, code+error 혼합을 거절한다. OAuth 표준의 unknown response parameter는 무시하며 자체 API의 unknown key 거절과 구분한다. Cookie는 browser CSRF 연결, state는 callback/request 연결, 앱 verifier는 exchange 자격으로 서로 대체하지 않는다.
3. `browser_started → processing`: 짧은 DB transaction으로 callback을 원자 claim한 뒤 provider HTTP를 수행한다. 외부 HTTP 동안 DB row lock을 유지하지 않는다. Replay/동시 callback은 provider 교환을 중복 실행하지 않는다. Claim 이후 token·identity/JWKS 검증 전체에 단일 **10초 deadline**, 자동 retry 0회다.
4. `processing → exchange_ready`: 검증 후 request row를 다시 잠그고 여전히 processing·유효할 때만 subject와 새 code hash를 저장한다. `codeExpiresAt=min(검증 완료 시각+60초,requestExpiresAt)`다. Raw code는 완료 HTML을 만드는 동안만 보유하고 외부 token 원문은 저장하지 않는다. Reload로 같은 code를 복원하거나 provider code를 재교환하지 않는다.
5. `exchange_ready → consumed`: code hash·request ID·client·S256 proof·TTL·상태를 확인해 계정/session 생성과 소비를 같은 transaction에서 commit한다. 동시 exchange는 하나만 성공하고 loser는 session/refresh를 추가 생성하지 않는다. 소비된 code의 token 재전달 grace는 없다.

Rollback이 확실하면 code는 미소비다. Commit 응답 유실이면 성공/실패를 추정해 token을 재발급하지 않고 새 로그인을 안내한다. 미수신 session은 logout할 수 없을 수 있으며 30일 미사용으로 끝난다. 절대 수명이나 자동 복구를 추가하지 않는다. Proof 불일치처럼 자격 미증명 실패는 valid request/code를 소비하거나 session을 생성·폐기하지 않는다.

Cancel/provider 실패/만료/crash는 성공이 아니다. Provider code는 재사용하지 않고 새 로그인한다. 남은 processing도 TTL 뒤 terminal 정리 대상이다. 정상 terminal commit의 secret/proof/subject 삭제와 물리 보관 지연은 [`auth-database.md`](auth-database.md)의 승인된 contract를 따른다.

## Exchange code entropy 보완 — 승인됨

이 절은 [exchange code entropy 리뷰](https://github.com/blahaj94/ldb/pull/48#discussion_r3940472415)의 명세 누락을 보완한 승인된 contract다. 기존 8개 승인을 소급한 것이 아니라 위 별도 추가 승인으로 이 세부 규격을 확정했다. 기존 명세의 누락을 짧은 code 선택 허용으로 해석하지 않는다. 이번 Rule-only 작업에 구현을 추가하지 않으며, 다음 작업은 별도 Issue·착수 지시·dependency와 미결정 gate를 확인하고 [`change-control.md`](change-control.md)를 따른다.

- Raw exchange code는 provider identity 검증 완료 뒤 **독립적인 새 32-byte CSPRNG 값**을 생성해 canonical unpadded base64url **43자**로 인코딩한다. 앱/provider verifier, launch ticket, state/nonce, request ID, provider code, 이전 exchange code를 재사용하거나 이 값들에서 파생하지 않는다.
- `POST /auth/exchange`의 code는 string이며 길이가 정확히 43자, 모든 문자가 `[A-Za-z0-9_-]`에 속해야 한다. Strict base64url decode 결과가 정확히 32byte이고 이를 unpadded base64url로 다시 인코딩한 값이 입력과 정확히 같아야 한다. Padding·공백·잘린 값·비canonical 인코딩을 자동 보정하지 않는다. **SHA-256 입력은 decode한 원래 32byte**이며 인코딩된 ASCII string을 hash하지 않는다. 생성·검증 모두 그 32byte digest를 `exchange_code_hash`로 저장·비교한다.
- 기존 `processing → exchange_ready` 원자 전이에서 검증 subject·위 hash·기존 code deadline을 함께 저장한다. Raw code는 완료 HTML의 등록 앱 복귀 버튼을 만드는 처리 동안만 보유하고 DB에 저장/복원하지 않는다. 완료 HTML에는 이 code만 전달하며 verifier/token은 넣지 않는다. API/proxy/APM/Desktop의 URL/body/HTML log·capture 제외는 [`auth-api.md`](auth-api.md)를 그대로 따른다.
- 기존 JSON pre-parser와 field validation 순서를 유지한다. Code 형식 실패는 `400 INVALID_AUTH_REQUEST`, 형식이 유효한 code의 hash/request/client/verifier 불일치·소비·만료는 `400 LOGIN_EXCHANGE_INVALID`다. 새 error code를 추가하지 않는다. 기존 `min(검증 완료 시각+60초,requestExpiresAt)`·전체 600초 TTL, request/client/S256 binding, 단일 소비·동시 exchange 하나만 성공·실패 시 다른 session 미변경을 유지한다.

## Google identity

- Authorization code + `openid profile`만 요청하고 email·offline access를 요청하지 않는다. 서버가 등록 client secret으로 token을 교환하며 UserInfo를 추가 호출하지 않는다.
- ID Token issuer 허용값은 `https://accounts.google.com`, `accounts.google.com`이다. Signature·RS256·trusted JWKS·exp/iat·transaction nonce를 확인한다. `aud`는 request snapshot의 단일 Google web OAuth client ID string과 exact match하고 `azp`가 있으면 같은 ID여야 한다. 자체 `desktop` 값을 audience로 쓰지 않는다.
- `sub`는 nonempty case-sensitive ASCII string, 최대 255자이며 검증한 sub만 영구 identity로 저장한다. `at_hash`가 있으면 access token과 검증한다. Profile name/photo 등은 버린다.
- #39가 확인한 Google discovery의 S256에 따라 별도 server PKCE를 사용하고 OIDC nonce도 독립 검증한다. ID Token의 RS256은 자체 access JWT의 ES256과 구분한다.
- JWKS URI/provider origin은 trusted registry/discovery allowlist에서만 온다. Token의 jku/x5u/임의 URL을 fetch하지 않는다. Google guidance에 따른 JWKS cache/회전을 사용하고 unknown kid는 bounded refresh 후에도 검증 불가하면 실패한다. 자체 JWT와 issuer/audience/type/key 집합을 분리한다.

## Discord identity와 PKCE gate

`identify`만 요청하고 confidential server code 교환에 client 인증·exact callback을 사용한다. 반환 Bearer access token·허용 scope를 확인해 고정 `GET https://discord.com/api/v10/users/@me`를 한 번 호출한다. 유효 JSON user object의 id를 decimal snowflake string으로 검증하고 JS Number로 변환하지 않는다. Client 제출 ID/username/email이나 opaque token의 JWT 해석을 신뢰하지 않는다. 검증 id만 저장하고 나머지 이름/email/avatar는 버린다.

**일반 OAuth2 confidential HTTPS callback에서 Discord PKCE 지원/enforcement는 미확인이다.** Embedded SDK의 S256 문서를 그 보장으로 확대하지 않는다. 별도 server S256 적용을 권고하되 구현 전에 해당 flow 공식 근거를 확보하고 후속 credential E2E에서 wrong/missing verifier·downgrade 거절을 확인한다. 지원을 확인하지 못하면 Discord 부분을 보류하고 사용자에게 대안/위험 결정을 받는다. State+cookie만으로 code injection까지 방어했다고 하거나 PKCE를 생략하지 않는다. 자체 앱 S256 필수 여부와 별개의 gate다.

## Provider token과 revoke

서명/JWT 검증은 library에 맡기고 자체 parser/crypto를 만들지 않습니다. 패키지 선택과 버전 변경은 [API 의존성 관리 기준](api-runtime.md#의존성-관리)을 따르며, 이 문서의 서명·알고리즘·claim 검증 계약을 유지합니다. 현재 사용 패키지와 연결은 [Google adapter Reference](../reference/auth-login-development.md#google-adapter-연결점)에서 확인합니다.

Provider token·raw 응답·provider code는 해당 callback 메모리에서만 사용하고 성공/실패/취소/timeout 모두 finally에서 참조를 해제한다. DB/log/file/queue에 쓰지 않고 JS string의 즉각 zeroization을 보장하지 않는다. Discord refresh와 예상치 않은 Google refresh도 보관/사용하지 않는다. Provider PKCE verifier만 별도 암호화 transient field에 둔다.

로그인 직후나 기기 logout에 provider revoke를 자동 실행하지 않는다. 폐기와 grant revoke는 다르고 revoke는 다른 grant/token에도 영향을 줄 수 있다. Provider 설정에서 동의 철회가 발생해도 자체 JWT/session 자동 폐기를 추정하지 않는다. 자체 idle/logout/reuse 정책을 유지하고 다음 소셜 로그인에서 다시 provider 검증하는 정책이 승인됐다. 즉각 연동 폐기는 별도 event/계정 정책 대안이다.

일반 연결 해제 endpoint/UI는 이 로그인 범위 밖이다. 탈퇴의 purpose-bound 재인증·동일 계정 확인·preparing/durable intent 확정·revoke 결과와 로컬 삭제 분리·진행 login 차단은 [승인된 탈퇴 contract](auth-withdrawal-proposal.md)의 D1–D5를 따른다. Login callback의 기존 TTL/deadline·자동 retry 0과 구분되는 탈퇴 extension이며, token 비보관은 유지하고 별도 구현 착수·provider 환경/경합 검증을 요구한다.

## 근거의 범위

아래는 #39가 2026-09-05에 읽은 근거이며 실제 provider 연동 검증 성공을 뜻하지 않는다. 이동 가능한 source는 이후 바뀔 수 있다.

- Google: [server flow](https://developers.google.com/identity/openid-connect/openid-connect#server-flow), [OIDC reference](https://developers.google.com/identity/openid-connect/reference), [discovery](https://accounts.google.com/.well-known/openid-configuration), [revoke](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke)
- Discord: [OAuth2](https://docs.discord.com/developers/topics/oauth2), [User](https://docs.discord.com/developers/resources/user), [Embedded SDK](https://github.com/discord/discord-api-docs/blob/main/developers/developer-tools/embedded-app-sdk.mdx), [revoke](https://docs.discord.com/developers/topics/oauth2#token-revocation)
- Confidential client PKCE 권고: [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1)
