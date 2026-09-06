---
type: rule
status: active
enforcement: approval-required
scope: apps/api apps/desktop authentication HTTP boundary
last-reviewed: 2026-09-06
rationale: 로그인과 계정 API의 입력·오류·credential 노출 경계를 구현 전에 고정한다.
evidence: "PR #48 사용자 승인: https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519 ; 설계 근거: Issue #39 Proposal Revision 2 https://github.com/blahaj94/ldb/issues/39#issuecomment-5551313691"
exceptions: 사용자 구현 금지 조건을 유지하며 실제 client 등록과 OS 저장 실행·검증은 별도 gate다.
review-after: 최초 인증 integration validation 또는 client boundary 변경 시
---

# Authentication API Contract

이 문서는 [PR #48의 사용자 승인](https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519)을 반영한 Rule이다. 승인된 contract는 현재 구현·검증 성공을 뜻하지 않는다. 사용자가 미결정 gate 유지와 구현 금지를 명시했으므로 후속 착수 지시 전에는 구현하지 않으며 [`change-control.md`](change-control.md)를 따른다. OAuth는 [`auth-oauth.md`](auth-oauth.md), token/session은 [`auth-session.md`](auth-session.md), 활동은 [`auth-activity.md`](auth-activity.md), schema는 [`auth-database.md`](auth-database.md), dependency·운영 gate는 [`auth-runtime.md`](auth-runtime.md)가 canonical contract다.

탈퇴 전용 endpoint·statusToken 자격과 정제 오류는 [승인된 탈퇴 contract](auth-withdrawal-proposal.md)가 canonical source다. 아래 기존 login/session/account endpoint와 별도 extension이며, shared pre-parser/no-store/log 규칙을 재사용하되 status/resume 자격을 일반 JWT 기능 권한으로 확대하지 않는다. 제품 endpoint 구현 완료나 기존 검증 AC 변경을 뜻하지 않는다.

## Client와 transport

- Desktop은 public client이며 자체 `clientId`는 `"desktop"`만 허용한다. 등록 항목 선택값이지 인증 secret·정품 앱 증명·provider OAuth client ID가 아니다. Web/mobile client나 요청자가 제공하는 provider client ID를 추가하지 않는다.
- Provider별 OAuth client configuration은 서버에 하나씩 등록하고 API가 선택한다. Electron main은 OAuth 요청 상태·verifier·token 보관을, renderer는 표시 요청을 담당한다. Main↔preload IPC와 OS 보안 저장 설계는 승인된 [Desktop contract](desktop-auth.md)를 따른다. 실제 구현 착수·OS 저장 검증·등록값은 별도 gate다.
- 외부 browser는 provider 화면과 API callback/완료 화면을 담당한다. Provider secret과 token 교환은 API에서만 처리한다. 모든 제품 API는 HTTPS다.
- 자체 JSON request는 표의 key만 가진 object다. Unknown key·array·null·wrong type을 거절하고 string/boolean을 coercion하지 않는다. 기존 검색 raw query contract는 [`character-search.md`](character-search.md)를 유지한다.
- 기능 API의 인증은 정확히 하나의 `Authorization: Bearer <access JWT>`다. Header 중복·잘못된 scheme·body/query의 token 대체 전달은 인증 성공으로 취급하지 않는다. Refresh는 JSON body로만, 앱 복귀 URL에는 자체 exchange code 하나만 전달한다.

## JSON pre-parser 우선순위

다음 순서는 승인된 JSON endpoint 보안 정책이다. Nickname grapheme 제한과 독립적이며 긴 결합문자 입력도 byte 상한으로 거절할 수 있다.

1. `Content-Type: application/json`과 charset 생략/UTF-8, `Content-Encoding` 생략/identity만 허용한다. 그 외에는 body parse 없이 415다.
2. 실제 body stream payload 합을 세어 최대 **16,384 byte**만 buffer한다. Chunked·Content-Length 없음/거짓에도 동일하며 선언 길이만 신뢰하지 않는다. 선언 길이 초과는 조기 413이 가능하고, 누적 초과 즉시 추가 buffer/parse를 중단해 413 응답 뒤 연결을 닫는다.
3. 상한 이하 전체 body를 strict UTF-8 decode하고 JSON parse한다. 깨진 UTF-8·빈 body·malformed JSON은 `400 INVALID_AUTH_REQUEST`다.
4. 보호된 nickname endpoint의 Bearer를 검증한다.
5. Object/field/domain을 검증한다.

Unsupported media+oversize는 415, supported media의 oversize+malformed JSON은 413, 상한 이하 malformed JSON+무효 JWT는 400, 정상 JSON의 무효 JWT+invalid nickname은 401이다. Transport 거절의 활동·quota·provider/upstream 호출은 0이다. Node/proxy가 먼저 거절한 HTTP framing 오류는 제품 JSON parser 오류와 구분하며 원문·내부 상세를 노출/기록하지 않는다. Body가 없는 `GET /me`, `GET /characters` 순서는 이 계약으로 바꾸지 않는다.

## Endpoint

표의 모든 auth DB/일시 장애는 `503 AUTH_UNAVAILABLE`, 설정/내부 오류는 `500 AUTH_INTERNAL_ERROR`다. JSON 구조 오류는 400이며 아래 고정 오류 의미를 사용한다.

| Endpoint | 입력과 성공 | 그 밖의 실패 |
| --- | --- | --- |
| `POST /auth/login-requests` | Public `{provider:"google"\|"discord",clientId:"desktop",codeChallenge,codeChallengeMethod:"S256"}` → 201 `{requestId,browserUrl,expiresAt}`. `browserUrl`은 API의 일회용 launch URL. 계정/session 생성 없음. | 형식·미등록 client: `400 INVALID_AUTH_REQUEST`. |
| `GET /auth/login/authorize?ticket=...` | 32-byte opaque ticket의 hash·TTL·상태 확인, browser cookie 설정 → 등록 provider authorization endpoint로 303. | Unknown/expired/used ticket: `400 LOGIN_REQUEST_INVALID` 정제 HTML. |
| `GET /auth/callback/google`, `GET /auth/callback/discord` | 서로 다른 등록 HTTPS URI. `state` 하나와 `code` 또는 `error` 하나를 request provider·cookie·TTL에 결합 → 200 완료 HTML의 등록 protocol 버튼에 자체 code 하나. 앱 로그인 완료는 아님. | 연결 오류·중복·만료: `400 LOGIN_REQUEST_INVALID`; 취소: `400 LOGIN_CANCELLED`; provider 검증/외부 오류: `502 AUTH_PROVIDER_ERROR`. 불신 redirect 금지. |
| `POST /auth/exchange` | `{requestId,clientId,code,codeVerifier}` → 200 token 응답+`user:{id,nickname}`+`isNewUser:boolean`. Code 소비·회원 연결/생성·새 session·첫 refresh를 한 transaction으로 commit. 임의 user/session ID 금지. | 형식: `400 INVALID_AUTH_REQUEST`; code/proof/client 불일치·소비·만료: `400 LOGIN_EXCHANGE_INVALID`. 실패로 다른 session을 폐기하지 않음. |
| `POST /auth/refresh` | `{refreshToken}` → 200 새 token 응답. 만료 access JWT를 요구하지 않으며 hash로 서버가 session을 결정. 소비/대체 hash commit 후만 응답. | 구조: 400; unknown/consumed/revoked/expired: 401. 확인된 consumed 재사용은 해당 session 폐기 commit 후 401. |
| `POST /auth/logout` | `{refreshToken}` → 204. Known current/consumed token의 session만 폐기. 종료/삭제/unknown도 204. Access 만료와 무관. | 구조: 400; DB: 503. 서버 성공을 확인하지 못하면 서버 logout 완료로 표시하지 않음. |
| `GET /me` | 유효 access JWT와 존재·소유·활성 user/session → 200 `{user:{id,nickname}}`. Provider/subject/email/photo 미노출. | 무효 JWT·없는 user/session·종료/만료: 401. |
| `PATCH /me/nickname` | 유효 access JWT와 존재·소유·활성 user/session, `{nickname:string}` → 200 `{user:{id,nickname}}`에 저장한 정리 결과. ID는 JWT에서 결정. | Pre-parser 오류가 먼저이며 정상 JSON에서는 인증 401이 `400 INVALID_NICKNAME`보다 우선. Validation 실패 시 기존 nickname 유지. |

Token 공통 응답은 `{tokenType:"Bearer",accessToken,accessTokenExpiresAt,refreshToken,sessionExpiresAt}`다. 시간은 UTC ISO 8601이고 `sessionExpiresAt`은 응답 당시 idle deadline 안내값으로 서버 검증을 대체하지 않는다. 이후 인정된 활동으로 바뀔 수 있다. `isNewUser`는 실제 user insert winner만 true다. 앱은 새 token을 안전하게 저장한 뒤 로그인 완료로 처리하고 session별 refresh single-flight 결과를 공유한다.

## 정제 오류

JSON 오류는 `{"error":{"code":"<CODE>","message":"<MESSAGE>"}}`만 사용한다. HTML도 같은 정제 의미만 표시한다. 검색의 code/message는 변경하지 않는다.

| HTTP / code | 고정 message |
| --- | --- |
| `400 INVALID_AUTH_REQUEST` | 인증 요청을 확인해 주세요. |
| `400 LOGIN_REQUEST_INVALID`, `400 LOGIN_EXCHANGE_INVALID` | 로그인 요청이 유효하지 않습니다. 다시 로그인해 주세요. |
| `400 LOGIN_CANCELLED` | 로그인이 취소됐습니다. |
| `400 INVALID_NICKNAME` | 닉네임을 확인해 주세요. |
| `401 AUTHENTICATION_REQUIRED` | 로그인이 필요합니다. |
| `413 REQUEST_TOO_LARGE` | 요청 크기를 줄여 주세요. |
| `415 UNSUPPORTED_MEDIA_TYPE` | JSON 형식으로 요청해 주세요. |
| `500 AUTH_INTERNAL_ERROR` | 인증 요청을 처리하지 못했습니다. |
| `502 AUTH_PROVIDER_ERROR` | 소셜 로그인을 완료하지 못했습니다. 다시 시도해 주세요. |
| `503 AUTH_UNAVAILABLE` | 현재 계정 기능을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요. |

## 닉네임

별도 auth validator에서 **원문 string → well-formed UTF-16 → 원문의 Unicode Cc·tab/newline·U+2028/U+2029 거절 → ECMAScript trim → 빈 값 거절 → extended grapheme cluster 1~20개** 순서로 검증한다. JSON escape의 lone high/low surrogate는 `400 INVALID_NICKNAME`이며 자동 보정하지 않는다. 정상 surrogate pair, 내부 공백·특수문자·다국어·emoji·ZWJ·variation selector를 보존한다. NFC/NFKC·case 변경·HTML entity 저장·OCR/검색 normalizer 재사용은 하지 않는다.

API의 `Intl.Segmenter('und',{granularity:'grapheme'})` 결과가 최종 기준이며 runtime Unicode/ICU version을 validation evidence에 기록한다. 최초 값은 `모험가`+`randomInt(0,1000000)`의 선행 0 포함 6자리다. 중복 허용, 기존 로그인 시 보존, 변경 횟수/cooldown 제한 없음이다. Renderer는 nickname을 string child/textContent로 출력하고 계정 표시에 provider를 포함하지 않는다. 문자 종류 제한을 XSS 대책으로 대체하지 않는다.

## 응답과 log sink

- 모든 인증 응답은 `Cache-Control: no-store`, browser 응답은 추가로 `Referrer-Policy: no-referrer`다. Third-party asset/analytics를 두지 않는다. Provider callback URL의 OAuth code와 access/refresh token URL 전달은 구분한다.
- API access/error/application log, proxy/gateway, APM/trace/redirect capture, Desktop main/renderer/IPC/deep-link 진단을 같은 경계로 검증한다. Launch ticket, 자체/provider code, 앱/provider verifier, state/nonce, 자체/provider access·refresh·ID token, Cookie/Set-Cookie/Authorization 및 이를 포함한 URL/body/완료 HTML 원문을 기록하지 않는다.
- Structured log는 route template·HTTP status·정제 error code·duration·credential과 별개인 임의 correlation ID 같은 비민감 field만 allowlist로 출력한다. User/provider subject·nickname도 제외하고 불신 request/response/error object를 통째로 serialization하지 않는다. Redaction이 불명확하면 원문을 생략하고 비민감 실패 counter만 남긴다. 설정/callback/oversize/parse 실패도 같다.
- 완료 HTML은 등록 복귀 버튼에 필요한 code만 담고 verifier/token을 DOM에 두지 않는다. 자체 response-body/DOM snapshot·protocol URL 진단 수집을 끈다. Script·외부 연결·third-party resource·frame embedding을 CSP로 금지하는 정적 화면을 사용한다.
- Browser/OS의 callback/deep-link history·외부 진단까지 서버가 지운다고 보장하지 않는다. 이 노출 한계는 짧은 TTL·single-use·앱 proof와 함께 승인됐다. Code 사본도 TTL 뒤 교환할 수 없고 verifier 없이 교환할 수 없다. TTL만으로 만료 전 노출·불필요한 보관을 정당화하지 않는다.

표준 근거는 #39가 2026-09-05에 검토한 [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html), [ECMA-402 Segmenter](https://tc39.es/ecma402/#sec-intl.segmenter)다. 실제 browser/OS/provider 검증 성공 evidence가 아니다.
