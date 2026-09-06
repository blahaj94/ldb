---
type: rule
status: proposed
enforcement: approval-required
scope: account withdrawal, identity races, deletion retention and recovery
last-reviewed: 2026-09-06
rationale: cascade 밖의 탈퇴 진행 상태와 삭제 보존을 하나의 승인 가능한 정책으로 연결한다.
evidence: "Issue #69; 부모 Issue #37의 탈퇴 gate; Issue #39 Proposal Revision 2"
exceptions: 사용자 승인 전 active Rule을 대체하지 않으며 제품 구현과 실제 외부/삭제/복원 실행을 허용하지 않는다.
review-after: 사용자 정책 결정, 운영 저장소 선정 또는 최초 경합·복원 통합 검증 시
---

# 탈퇴·삭제·재가입·복원 승인안

**전체가 미승인 proposal이다.** [Design #69](https://github.com/blahaj94/ldb/issues/69)의 설계안 작성 결과이며 Rule 승인과 구현 검증은 별개다. [#39 최종 설계](https://github.com/blahaj94/ldb/issues/39#issuecomment-5551313691)와 현재 [DB](auth-database.md)·[OAuth](auth-oauth.md)·[runtime](auth-runtime.md) Rule의 미결정 gate를 구체화한다. 승인 전에는 현재 contract와 #68·refresh 작업의 AC를 유지한다. 이 문서는 제품 code·schema 실행물·운영 runbook이 아니다.

## 권장안과 사용자 결정

권장안은 **새 재인증으로 확정한 탈퇴를 되돌리지 않고, revoke를 한 번 시도한 뒤 외부 결과와 구분하여 LDB 데이터를 삭제**하는 것이다. 삭제 intent를 복원 대상 밖에 먼저 내구성 있게 기록한다. 재가입은 완료 후 600초를 기다리고 새 로그인 요청으로만 허용한다. 삭제 결과는 별도 읽기 자격으로 24시간 조회한다. 삭제 회원 UUID는 복원 차단 목적만으로 한정 보관하고 provider identity는 짧은 경합 차단에만 쓴다.

| 승인 항목 | 권장 선택·이유 | 선택하지 않은 대안과 영향 |
| --- | --- | --- |
| D1 탈퇴 확정/취소 | 최종 확인을 한 요청에서 동일 계정의 새 OAuth round trip까지 성공한 원자 commit을 확정점으로 한다. Provider의 기존 로그인 session 재사용은 허용한다. 이후 계정 기능 차단·취소 없음. 그 전 취소/만료는 회원 유지. 경합의 단일 기준을 만든다. | 항상 비밀번호/추가 인증을 강제하는 대안은 provider별 보장과 계정 접근 상실 복구 정책이 필요하다. 삭제 유예/복구 UI도 별도 보관·권한 설계가 필요하다. |
| D2 provider 실패 | 확정 뒤 revoke의 실패/불명도 로컬 삭제를 막지 않는다. 결과를 분리해 표시하고 삭제 뒤 자동/서버 revoke 재시도는 하지 않는다. Provider 장애가 회원 보관을 무기한 연장하지 않게 한다. | Revoke 확인 때까지 삭제 보류는 장애·계정 접근 상실 시 탈퇴를 끝내지 못한다. Token을 암호화 저장해 재시도하면 현재 비보관 정책·key·queue·보관기간을 추가로 바꿔야 한다. |
| D3 재가입/진행 로그인 | 완료 후 600초 대기, 그 이후 생성한 요청만 새 UUID·nickname·session으로 가입. 기존/대기 중 OAuth로 자동 재가입하지 않는다. 기존 login TTL 600초에 맞춘 작은 차단 구간이다. | 즉시 새 요청 재가입은 가능하지만 이전 revoke의 지연 효력과 새 동의가 더 쉽게 경합한다. 장기 차단은 provider 식별 보관을 늘린다. 600초도 provider 효력 완료를 보장하지 않는다. |
| D4 삭제 후 식별/조회 | 조회 자격은 생성부터 고정 86,400초, identity HMAC fence는 완료부터 최대 1,200초, 삭제 UUID journal은 아래 8일 정책. 재가입 계정에는 이전 결과를 연결하지 않는다. | 조회 자격 없음은 응답 유실 복구를 어렵게 한다. 장기 receipt·원문 subject tombstone은 불필요한 추적/보관을 늘린다. HMAC도 익명정보로 간주하지 않는다. |
| D5 복원/백업 | 성공 dump 최대 7개와 snapshot 나이 7일 상한을 함께 적용한다. 별도 삭제 journal 없이는 복원 공개 금지. 복원 시 전 회원 session/refresh/OAuth·receipt 무효화와 JWT key 교체, 600초 신규 로그인 중단을 수용한다. | 성공본 개수만 제한하면 백업 실패 동안 오래된 개인정보가 무기한 남는다. 선택적 session 복원은 옛 credential과 삭제 경계를 재검증하는 복잡성을 추가한다. |

D1–D5와 아래 수치/권한/한계를 Draft PR의 명시적인 `승인` comment로 결정해야 한다. 이 수치는 법적 보관기간을 주장하지 않는 제품·운영 제안이다. 일부 선택만 승인하면 의존 항목의 수정안을 먼저 검토한다. 설계 승인 뒤에도 공유 Rule/schema 후속 구현과 실제 환경 실행은 별도 착수 지시가 필요하다.

## 권한과 시간 기준

- `T`는 [session Rule](auth-session.md)의 lock 뒤 fresh UTC whole-second다. 모든 TTL은 `T >= expires_at`에 거절하며 HTTP 재시도·조회·재인증으로 연장하지 않는다. 아래 600초는 10분, 86,400초는 24시간, 604,800초는 7일, 691,200초는 8일이다.
- 요청 생성은 유효 Access JWT와 존재·소유·활성·idle 미만료 user/session을 요구한다. 원 user UUID, 원 session UUID, provider, client/등록 snapshot을 서버가 결정한다. Client의 임의 subject/user ID·email·nickname은 삭제 대상 증명이 아니다.
- 앱 main은 독립 32-byte CSPRNG `statusToken`을 canonical base64url 43자로 만들고 요청 UUID와 함께 전송한다. 서버는 strict decode한 32byte의 SHA-256만 저장한다. Request UUID 단독·JWT·refresh·새 재가입 계정·browser cookie는 이 자격을 대체하지 않는다. Raw 자격은 URL/renderer/로그에 넣지 않으며 main의 기존 보안 저장 경계에서 만료 또는 결과 확인 후 지운다. 구체적 IPC/OS 구현은 후속 범위다.
- `statusToken`은 해당 요청의 정제 상태 읽기와 이미 확정된 로컬 작업 재개만 허용한다. User/profile 조회·탈퇴 확정·새 재인증·provider 호출·다른 요청 조작·재가입 자격으로 쓰지 않는다. 유출 시 해당 탈퇴 진행 사실은 노출될 수 있으므로 credential로 취급한다.
- 동일 계정 재인증은 별도 purpose=`withdrawal`로 수행한다. 기존 OAuth의 provider snapshot, state+cookie, nonce, PKCE, identity 검증을 재사용하되 로그인 exchange code·user/session/refresh는 발급하지 않는다. 요청 목적·원 user/session·provider+subject·유효한 browser attempt를 모두 비교한다. 여기서 재인증은 새 code 교환·nonce/PKCE와 동일 identity 검증을 뜻한다. Provider session 재사용을 허용하며 비밀번호 재입력/최근 password 인증을 보장하지 않는다. Account chooser 표시만으로 통과시키지 않는다. 이 보장 수준도 D1 승인 대상이다.
- 최종 확인 화면은 취소 불가 시점, 해당 provider grant 전체에 줄 영향, revoke 미확인이어도 LDB 삭제 진행, 재가입 대기, receipt 만료를 안내한다. `confirmation="delete_account"` 제출 후 시작한 재인증이 일치해야 확정할 수 있다. Login 요청을 withdrawal로 전환하거나 callback alone으로 새 삭제 요청을 만들 수 없다.

## 상태 전이와 원자 경계

한 user에 미완결 요청은 최대 하나다. 생성부터 재인증 전체 TTL은 600초다. Browser attempt는 created/browser_started/processing의 기존 일회용 claim·proof 규칙을 사용하고 한 번 사용한 code는 재교환하지 않는다. 실패한 attempt의 새 재인증은 같은 요청의 남은 TTL 안에서 원 session이 여전히 유효할 때만 새 proof로 시작한다. 별도 provider HTTP 동안 DB lock을 잡지 않는다.

| 상태 | 진입 조건/처리 | 다음 상태·실패 결과 |
| --- | --- | --- |
| `awaiting_reauth` | 생성/최종 확인 저장. 회원은 active, 기존 기능 유지. Receipt 만료 시각은 생성+86,400초로 고정. | 재인증 성공 후보 → 아래 확정 transaction. 취소·600초 만료 → `cancelled`/`expired`. Provider 거절·계정 불일치·잘못된 proof는 회원 변화 없이 정제 실패. |
| `deleting` (확정점) | 요청→identity 직렬화→user→원 session 잠금. TTL·request attempt·원 session·동일 identity를 fresh T로 재검증하고 users.lifecycle=`deleting`, accepted_at, revoke attempt claim을 함께 commit. 이 commit 후 취소 불가. | `revokeOutcome=pending`으로 같은 callback에서 새 access token revoke 1회. 원 session이 먼저 logout/만료/삭제됐다면 확정 없이 거절. 확정 commit 불명은 재조회 전 외부 revoke를 시작하지 않는다. |
| `deleting` / revoke 종결 | 확정점부터 10초 단일 deadline, 자동 retry 0회. 그 deadline까지 claim 주체만 진행하고 resume는 대기 상태를 반환한다. Outcome을 `confirmed`/`failed`/`unknown`으로 저장하고 token 참조 해제. Crash/claim 후 timeout/결과 저장 유실은 `unknown`으로 수렴하며 provider 재호출 없음. | 로컬 삭제 intent journal 기록으로 진행. Provider 성공이 user 삭제 성공을 뜻하지 않음. |
| `deleting` / intent 준비 | 복원 대상 밖 journal에 `(deletionId,oldUserId,acceptedAt)`의 단일 intent를 내구성 있게 append하고 ack/동일 ID 재조회로 확인한다. DB에는 journal sequence를 저장. | 실패/불명은 `deleting` 유지·503/처리 중. User/session 차단 유지, 로컬 재개만 가능. 확인 전 SQL DELETE 금지. |
| `completed` | journal intent 확인 후 요청→identity→user 잠금 transaction에서 대상 UUID의 user 삭제(cascade), 필요한 개인 데이터 FK 삭제, fence 갱신, completed_at 및 receipt 결과를 함께 commit. | 명확한 rollback이면 그대로 재개. Commit 응답 유실/불명은 같은 요청 조회로 확인하며 새 user/session 생성 없음. Journal에 완료 시각을 idempotent 기록하는 후처리를 이어간다. |
| `cancelled`, `expired` | 확정 전만 가능. 재인증 proof/원 user·session 연결을 지우고 요청 ID/hash/상태/시각만 남긴다. | 같은 요청 부활 없음. 유효한 계정에서 새 요청을 생성할 수 있음. |
| receipt 만료/삭제 | 생성+86,400초 이상 또는 복원으로 자격 무효화. 완료/취소/만료 결과와 hash 삭제. | 모든 lookup은 같은 `404 WITHDRAWAL_REQUEST_UNAVAILABLE`. 미완료 로컬 삭제 obligation은 receipt와 독립해 끝내며 조회 자격을 연장하지 않음. |

확정 전에 현재 user/session을 확인할 수 없는 DB 장애는 503이며 삭제하지 않는다. 확정 이후의 DB/journal 장애는 탈퇴 취소가 아니다. `completed` 응답은 로컬 DELETE와 결과 commit을 확인한 뒤만 허용한다. Provider 결과가 confirmed이면 “LDB 탈퇴 완료·연결 해제 요청 확인”, 그 외에는 “LDB 탈퇴 완료·소셜 연결 해제는 확인하지 못함”을 표시한다. 백업에는 보관 상한까지 암호화된 사본이 남을 수 있음을 구분한다.

## Revoke 결과·재개·중복

| 관측 | 저장/재시도 | 사용자 안내 |
| --- | --- | --- |
| 공식 성공 응답 | `confirmed`. 동일 요청에서 재호출하지 않음. 지연 효력 가능성 유지. | 연결 해제 요청 확인. 다른 해당 grant token에도 영향 가능. |
| 명확한 요청 거절, Google `invalid_token`, 설정/인증 오류 | `failed`. Invalid token이 특정 token의 무효를 나타내도 grant 전체 완료로 승격하지 않음. 로컬 삭제 계속. | LDB 탈퇴와 별개로 provider 설정에서 앱 연결 상태 확인/해제. |
| Timeout·연결 종료·5xx·예상 밖 응답·crash·결과 저장 실패 | `unknown`. 요청이 처리됐을 수도 있으므로 같은/새 token으로 서버 retry하지 않음. 늦은 응답이 outcome/삭제 대상을 다시 바꾸지 못함. | 소셜 연결 해제 여부 미확인. 이후 다시 동의했다면 설정에서의 수동 해제가 새 동의에도 영향을 줄 수 있음을 안내. |
| 확정 전 재인증 실패 | Provider code/token 저장 없음. TTL 내 원 session+statusToken으로 새 browser attempt 가능. | 계정 일치/새 인증을 다시 확인. 회원 유지. |
| 확정 후 앱 종료·HTTP 유실·재시작 | receipt로 조회/로컬 재개. 단일 로컬 executor가 revoke claim deadline 이후 claim/CAS로 journal append·DELETE를 반복 가능하게 처리. 동시 resume는 같은 결과, 중복 revoke 없음. | `deleting`은 처리 중이며 완료를 추정하지 않음. |

재인증의 code 교환+identity 검증에는 기존 10초/자동 retry 0을 적용한다. 확정 뒤 revoke는 별도 10초/자동 retry 0이며 callback에서만 새 token을 사용한다. 확정 DB 경계에서 token이 만료되거나 처리 주체가 사라지면 `unknown`으로 로컬 삭제를 계속한다. Token·provider code·raw 응답은 DB/file/queue/journal에 보관하지 않는다. 이 추가 외부 단계와 로컬 재개 executor는 기존 로그인 callback을 확장 승인한 것으로 간주하지 않는다.

같은 `(requestId,statusToken,원 user)` 생성 재전송은 기존 상태를 반환하며 TTL·browser proof·동의를 갱신하지 않는다. 다른 key로 같은 user에 요청하면 `409 WITHDRAWAL_IN_PROGRESS`다. Key 충돌/다른 user/틀린 자격은 기존 row·account 존재를 드러내지 않는 정제 거절이다. 확정 후 session이 차단/삭제되면 생성 endpoint 재전송 대신 전용 status/resume를 쓴다. 재가입한 user의 새 요청은 다른 deletionId와 UUID를 가진다.

## 로그인·기능 경합의 최종 결과

Identity 직렬화 key는 길이 구분 encoding의 `(provider,subject)` HMAC-SHA-256이다. 별도 secret key/version을 DB 밖에 두고 raw subject나 단순 사전 대입 가능한 hash를 tombstone으로 남기지 않는다. 모든 exchange와 탈퇴 확정/삭제는 user 존재 여부와 무관하게 같은 identity transaction lock을 획득한다. Lock key가 충돌하면 직렬화만 늘고 full digest/identity 일치 검사 없이 계정을 합치지 않는다.

Lock 순서는 **자기 OAuth 또는 withdrawal row → identity transaction lock → user → session → refresh**다. 다른 session/cleanup 작업이 뒤에서 OAuth/withdrawal/identity lock을 잡지 않는다. 검색 활동은 기존 session-only lock을 유지한다. 탈퇴는 다른 login row를 잠가 전수 취소하지 않고 callback 완료 및 최종 exchange에서 user lifecycle/fence·TTL을 확인한다. Identity를 아직 모르는 callback은 검증 후 검사하고, 그 검사를 통과해도 exchange에서 다시 검사한다.

삭제 완료 시 fence에 `rejoinNotBefore=completedAt+600`, `expiresAt=completedAt+1200`을 저장한다. Login은 `created_at >= rejoinNotBefore`이고 fresh T도 그 이상일 때만 가능하다. 그 이전에 만든 요청은 나중에 눌러도 실패한다. Fence는 추가 600초 동안 남아 cooldown 중 생성한 login도 끝까지 거절한다. `expiresAt`에서 삭제해도 그 요청들은 원래 600초 TTL로 이미 만료다. Cleanup/재시도는 시간을 늘리지 않는다. Clock 역행/불명은 운영 fail-closed 조건이다.

| 경합 | 최종 결과 |
| --- | --- |
| Exchange가 먼저 user/session 생성 commit | 뒤의 탈퇴가 같은 user를 deleting으로 바꾸고 최종 cascade한다. 늦은 token 응답도 refresh·계정 기능에 유효하지 않다. |
| 탈퇴 확정이 먼저, OAuth/exchange가 대기 | 같은 identity의 deleting user 또는 fence를 확인해 `400 LOGIN_EXCHANGE_INVALID`/기존 callback 정제 실패. 새 user/session/refresh 생성 없음. |
| 삭제 전/중 callback이 identity 검증 완료 | Subject 검증은 회원 생성 허가가 아님. 최종 exchange의 lifecycle/fence/created_at 검사에서 거절. 신규 사용자로 자동 전환하지 않음. |
| 완료 후 600초 직전/정확한 경계 | 직전 시작 요청은 계속 실패. 경계부터 새로 생성한 요청만 재가입 가능. 새 UUID·랜덤 nickname이며 이전 receipt/session/활동과 연결하지 않음. |
| Refresh 또는 계정 기능이 확정 전에 lock/commit | 기존 승인 결과가 먼저 완료될 수 있음. 이후 deleting을 확인한 refresh·GET/PATCH는 401, 기존 refresh 전체는 최종 cascade. Admission만 먼저 완료된 계정 기능은 기능 단계에서 lifecycle 재확인해 결과/변경 0. |
| 탈퇴 확정 후 refresh·계정 기능 | user.lifecycle 검사에서 401, 새 token·조회·nickname 변경 없음. 탈퇴/status/revoke는 session 활동이 아님. |
| Logout·refresh reuse·session cleanup | 기존 session별 의미를 유지. 확정 전에 원 session이 끝나면 재인증 확정 실패. 확정 뒤에는 로컬 삭제 obligation을 취소하지 않음. |
| 검색과 deleting/삭제 | 기존 residual 정책 유지: 유효 JWT의 검색은 exp까지 가능, session-only 활동을 먼저 기록할 수 있지만 삭제가 cascade함. 검색으로 user/session 재생성 없음. 이 제안은 JWT 즉시 검색 차단을 약속하지 않음. |
| 신규 재가입 후 늦은 기존 executor/receipt | 삭제 대상 oldUserId만 사용하고 provider identity로 현재 user를 찾아 DELETE하지 않음. 새 user와 session 보존, 서버 revoke 재시도 없음. |

## 최소 state/schema/API 변경

아래는 승인 대상 논리 schema이며 EntitySchema/SQL/Migration을 추가하지 않는다. 새 dependency는 제안하지 않는다. Index·CHECK·Migration은 후속에서 이 상태별 null·단일성·잠금 의미를 검증해야 하며 새로운 보관 field를 임의로 늘릴 수 없다.

| 대상 | 최소 변경 |
| --- | --- |
| `users` | `lifecycle=active\|deleting`, nullable `withdrawal_id`의 일관된 pair. Deleting 동안 identity unique는 유지. 기존 ID 재사용 없음. |
| `auth_withdrawals` (신규) | 요청 UUID PK, statusToken hash UNIQUE(32byte), status, created/expires/accepted/completed 시각, receipt deadline, 원 user/session UUID·provider/client/config binding, revoke outcome/claim 시각, journal sequence. User FK cascade를 두지 않고 최종 결과를 분리. 미완결 user당 unique. Proof는 상태별 nullable·terminal 즉시 제거. |
| 재인증 transient field | 위 withdrawal row의 별도 attempt ID와 launch/state/browser/nonce hash·암호화 PKCE·attempt 상태/TTL. 기존 OAuth와 동일 entropy/AAD에 purpose/attempt binding 추가. 원문 provider subject는 users에서 비교하고 이 row에 복제하지 않음. 최종 callback은 로그인 code를 발급하지 않음. |
| `auth_identity_fences` (신규) | HMAC digest+key version PK, rejoin_not_before, expires_at. FK/원 user UUID/원문 subject 없음. 필요한 기존 user identity는 삭제 transaction 메모리에서만 HMAC으로 변환. |
| 복원 control store (신규 운영 state) | 삭제 journal의 단조 sequence·deletionId unique·oldUserId·acceptedAt·완료 확인 시각, 승인된 backup inventory의 snapshot 시각/만료/폐기 evidence·journal checkpoint. Auth DB 복원으로 되감지 않는 독립 volume/권한 경계. Provider identity·token·receipt hash 없음. |

| API proposal | 자격·정제 결과 |
| --- | --- |
| `POST /auth/withdrawal-requests` | JWT + `{requestId,clientId:"desktop",statusToken,confirmation:"delete_account"}`. 201 `{requestId,status,reauthUrl,reauthExpiresAt,receiptExpiresAt}`. 같은 key의 재전송 200, 소비된 launch URL은 재발급하지 않음. |
| `POST /auth/withdrawal-requests/:id/reauthorize` | 원 user/session JWT + `{statusToken}`. 확정 전 남은 TTL에 새 일회용 browser attempt를 201로 제공. 이전 attempt는 무효화. 확정 후 거절. |
| Browser authorize/callback | purpose 전용 launch 및 provider callback 등록/분기. URL은 launch ticket/state/code만, statusToken 없음. 기존 state+cookie와 새 purpose-bound OAuth 결과 확인 후 상태 machine 진행. 성공 HTML은 정제 결과·앱 복귀 안내만, token/receipt/user ID 없음. |
| `POST /auth/withdrawal-requests/:id/status` | `{statusToken}`만으로 200 `{status,revokeOutcome,receiptExpiresAt,completedAt?,rejoinNotBefore?}`. Profile/subject/user/session ID·provider 원문 오류 없음. POST로 secret의 URL 노출을 피함. |
| `POST /auth/withdrawal-requests/:id/resume` | `{statusToken}`. 이미 확정된 로컬 삭제만 202 처리 중 또는 200 완료 상태. 확정 전은 409. 새 provider 요청/새 인증 권한 없음. |
| `POST /auth/withdrawal-requests/:id/cancel` | 원 user/session JWT + `{statusToken}`. 확정 전만 200 cancelled; 확정 경합에서 늦으면 409. |

모든 JSON은 [API Rule](auth-api.md)의 HTTPS·16,384byte pre-parser·no-store·allowlist log를 따른다. JWT 필요 endpoint는 pre-parser→JWT→fields→DB의 기존 순서다. Status-only endpoint는 pre-parser→field 형식→constant-time hash 비교·TTL→상태로 검사한다. 형식 오류 400, 유효 형식의 absent/wrong/expired credential은 동일 `404 WITHDRAWAL_REQUEST_UNAVAILABLE` (“탈퇴 요청을 확인할 수 없습니다.”), 조건 불일치는 `409 WITHDRAWAL_IN_PROGRESS` (“탈퇴 요청의 현재 상태를 확인해 주세요.”), 기존 인증 실패 401·DB/control store 일시 장애 503이다. Raw URL/body/credential·식별 field를 새 log sink에 추가하지 않는다. 인증 전 abuse 수치는 기존 미결정 운영 gate에 연결한다.

## 보관과 삭제

아래 기한은 용도 종료/정리 eligibility와 운영 목표다. 장애 중 물리 삭제 성공을 시간 경과만으로 주장하지 않는다. TTL 연장·조사 목적 보존·manual hold를 정상 경로에 두지 않는다. 신뢰할 cleanup/관측/폐기 evidence가 없는 환경은 이 보관 정책의 운영 준비 완료가 아니다.

| 정보 | 목적·최소 보유 | 기한과 삭제 조건 |
| --- | --- | --- |
| 현재 회원 데이터·sessions·refresh | 확정 전 서비스, 확정 후 old UUID 삭제에 필요한 기존 데이터 | 정상 flow에서 revoke 최대 10초와 journal ack 뒤 바로 원자 삭제. 확정 뒤 24시간 내 완료 목표. 초과는 incident·서비스 담당 개입, active 복구 금지. 실제 DB 불가 시 지연을 공개하고 성공으로 표시하지 않음. |
| 재인증 proof/원 user·session binding | 한 요청의 동일 계정·목적 확인 | Proof는 attempt 종결/취소/600초 만료 때 null. 확정 뒤 새 인증 불가. User/session binding은 DELETE 완료 때 null; 미완료 intent 처리에 필요한 oldUserId만 분리 보유. Provider token은 callback 메모리에서 finally 해제, crash zeroization 보장 없음. |
| Receipt | 요청 ID, credential hash, 정제 상태/revoke 결과·최소 시각 | 생성+86,400초에 접근 종료·삭제. 완료 때 새 24시간을 시작하지 않음. Receipt 유실/만료/복원 뒤 재발급·provider 로그인으로 이전 상태 복구 없음. 미완료 obligation에는 credential 불필요. |
| Identity fence | Provider identity HMAC·key version와 두 deadline, 자동 재가입 차단 | 완료+1,200초에 삭제. 완료+600초부터 새 로그인 허용. Lock/fence는 단일 active key를 공유하며 정상 교체는 모든 fence 만료/삭제와 관련 transaction drain 뒤만 허용. 유실 시 탈퇴/exchange를 멈추고 pending login 전부 무효화·진행 삭제 대조 뒤 600초 admission 중단 후 새 key 사용. |
| 삭제 journal | oldUserId, deletionId, sequence·accepted/완료 시각만. 복원 부활 차단 | 완료 확인+691,200초 보관. 그때 관련 모든 snapshot이 7일 한계 밖이며 승인 inventory에서 제외·실제 폐기됐음을 확인 후 segment compaction으로 UUID 제거. 미완료 intent는 완료시각을 조작해 만료시키지 않음. 24시간 이상 pending/폐기 실패는 incident이며 무기한 보관 허가가 아님. 안전한 삭제/복원 증명을 회복하기 전 공개 복원 금지. |
| Backup 사본·임시 dump/restore DB·복제본 | 승인된 암호화 recovery 사본. 모든 사본의 inventory/소유자 필수 | 성공본 최대 7개 AND 각 snapshot 시각+604,800초 미만. 실패 dump 즉시 삭제, restore scratch는 검증/실패 종료 때 삭제. Snapshot 나이는 복사/restore/re-backup으로 리셋하지 않음. 새 성공본이 없어도 만료본 사용·보관 연장 없음. |
| 운영 evidence/log | 개인식별 없는 결과 code·duration·집계·backup/journal 연속성 checkpoint | User/deletion/request UUID·HMAC·receipt·provider raw 응답을 일반 log에 보관하지 않음. UUID 제거 뒤 비식별 checkpoint와 사본 폐기 증명만 보존; 구체적 운영 log 기한은 후속 gate이며 개인정보의 대체 저장소로 사용 금지. |

삭제 journal의 pending/폐기 장애로 deadline을 넘긴 물리 잔여는 완료와 별도로 보고한다. 연결·디스크가 복구될 때까지 삭제를 보장할 수 없다는 가용성 한계이며, 자동 TTL 연장이나 조사용 보관을 선택한 것이 아니다. 운영 단계에는 24시간 incident 대응 책임자와 backup 폐기·journal compaction 감시가 반드시 필요하다.

## 삭제를 보존하는 복원 기준과 순서

복원 허용 조건은 **복원할 사본의 신뢰할 snapshot 시각/lineage + 현재 시점까지 누락 없는 별도 삭제 journal + 외부 checkpoint의 rollback 불가 확인**이다. 단순 checksum은 변조/되감기 부재 증명이 아니다. Journal과 최신 checkpoint/inventory는 auth DB의 restore 범위 밖에 있어야 하며 실제 저장 매체·내구성 ack·권한·동시 장애 범위는 운영 gate다. 같은 DB dump 안 tombstone만 복원하거나 최신 journal을 잃은 채 “백업 성공”만 확인해 공개하지 않는다. 외부 백업 서비스 도입은 이 제안에 포함하지 않는다.

1. 유지보수 gate로 API ingress·background executor·callback·exchange·refresh·account 쓰기와 기존 process를 멈춘다. 확정된 intent를 journal과 대조해 내구성 확보/미완료 상태를 보존한다. Quiescence를 증명할 수 없으면 복원을 시작하지 않는다.
2. 별도 DB에 나이 7일 미만인 승인 snapshot만 복원한다. 전체 journal checkpoint/연속성·pending intent와 backup lineage를 확인한다. 누락·복제본 미등록·clock 불명·journal/storage 손실은 fail closed이며 임의로 옛 DB를 공개하지 않는다.
3. 복원 DB에서 journal의 **모든 관련 intent oldUserId**에 해당하는 user와 현재/향후 개인 데이터 FK를 삭제한다. 완료 표시가 없는 intent도 사용자 확정 뒤의 삭제 obligation이므로 적용한다. 재가입한 새 UUID는 보존하고 provider+subject로 새 user를 찾아 삭제하지 않는다. 복원 snapshot의 deleting user도 원 intent와 일치시켜 완료하며 불일치는 중단한다.
4. 복원된 모든 auth_sessions/refresh, auth_login_requests, withdrawal proof/receipt·identity fence를 제거한다. 이전 receipt를 복원해서 조회 자격을 되살리지 않는다. 미완료 삭제 obligation은 journal에서만 재처리하며 provider revoke를 재실행하지 않는다. 전 회원은 재로그인이 필요하다.
5. DB 밖 새 ES256 signing key/kid와 새 provider PKCE key·fence HMAC key를 만들도록 운영 절차를 준비한다. 모든 이전 Access JWT verify key를 제거한 새 auth lineage를 전체 verifier에 적용한다. 기존 key와 900초 overlap을 주면 residual JWT가 살아남으므로 복원에는 정상 key rotation의 overlap을 적용하지 않는다. 실제 생성/등록은 별도 허가된 운영 실행이다.
6. 참조 무결성, old UUID 부재, 활성 session/refresh/OAuth/receipt 0, 옛 JWT/refresh/code 거절, 새 가입 시 새 UUID 보존을 격리 검증한다. 삭제 재적용 뒤 만든 사본만 새 lineage로 승격할 수 있고, 검증 전 restore DB를 backup해 원래 데이터 나이를 세탁하지 않는다.
7. 마지막 journal 대조 시점부터 600초 동안 login admission을 닫아 삭제 직후 cooldown을 전역으로 보존한다. 그동안 새 intent가 생기면 quiescence 실패로 다시 대조한다. 전 process의 새 key·lineage 및 검증 완료를 확인한 뒤 cutover한다. 실패하면 유지보수 상태를 유지하고 이전 snapshot으로 자동 복귀하지 않는다. 이전 primary도 격리/폐기 대상으로 관리한다.

이 절은 복원 설계 matrix이며 실행 성공 evidence가 아니다. Journal이 되감기거나 전체 저장소를 잃은 상황의 recovery point/손실 수용은 미결정이다. 증명할 수 없는 auth 데이터로 서비스를 재개하는 예외는 승인하지 않는다.

## 기존 contract 변경점·후속 연결점·환경 gate

| 현재 기준 | 이 proposal 승인 시 필요한 후속 변경 |
| --- | --- |
| [auth-database.md](auth-database.md): 4개 auth table, cascade와 삭제 gate | lifecycle·withdrawal/fence·복원 journal 도입, identity lock 선행·상태별 null/unique·cleanup·Migration matrix 갱신. 기존 4-table 검증을 지금 실패 처리하지 않음. |
| [auth-oauth.md](auth-oauth.md): login-only, callback 10초, token 비보관·탈퇴 원칙 | 별도 withdrawal purpose·새 OAuth round trip·같은 계정 확인·추가 revoke deadline, 실패/불명에도 삭제하는 선택. Login callback retry/TTL은 유지. |
| [auth-api.md](auth-api.md)·[auth-session.md](auth-session.md)·[auth-activity.md](auth-activity.md) | 새 endpoint/읽기 자격/404·409, deleting lifecycle 검사. Refresh/계정 기능 차단과 검색 residual 허용 구분. 복원에서만 전 회원 credential/옛 JWT 무효화. |
| [auth-runtime.md](auth-runtime.md), #37/#39 백업 방향 | 개수 외 7일 age cap·별도 control store·복원 gate·전원 logout. 실제 topology·durability·clock·retention 실행·운영 key 절차는 여전히 미확인. |

현재 관련 구현 위치는 `apps/api/src/auth/login/callback.ts`, `apps/api/src/auth/login/exchange.ts`, `apps/api/src/auth/identity-session.ts`, `apps/api/src/database/schemas/`, `apps/api/src/database/migrations/`다. 이번에는 이 파일을 변경하지 않는다. 기존 code/config에는 deleting/withdrawal/fence가 없으며 이는 알려진 미구현 gate이고 승인 contract 위반으로 보지 않는다.

후속 순서는 (1) D1–D5 승인과 기존 Rule/`docs/README.md` 소유 조율, (2) 승인된 공유 schema·admission/정리/복원 state를 별도 bounded 작업으로 구현, (3) 재인증/revoke·탈퇴 API와 Desktop 완료 조회 연결, (4) 경합·부분 실패·복원 통합 검증이다. 여기서 새 Issue나 Worker를 자동 배정하지 않는다. Google #68/refresh는 현재 승인 contract로 독립 검증하고 이 proposal로 AC를 즉시 바꾸지 않는다.

운영 미결정 gate는 provider별 실제 callback/client 등록·동일 계정 재인증과 취소의 UI 검증·revoke 응답/권한·project grant 공유 영향, Discord PKCE gate, control store의 auth DB와 독립된 내구성/rollback 감지·권한, 모든 사본 inventory·암호화/폐기, single-writer/clock·24시간 장애 대응 책임자, 실제 재인증/복원 E2E와 platform이다. 환경이 없다는 사실과 정책을 아직 승인하지 않았다는 사실을 구분한다. 실제 credential·provider 호출·삭제·복원은 이번에 하지 않는다.

## Validation matrix — 설계 검토와 후속 실행 구분

각 행의 기대 결과를 문서와 독립 review로 검토한다. 이번 문서 검증은 link/구조/diff scope/whitespace다. 아래 runtime·DB·provider·restore case는 승인 후 구현 검증 항목이며 지금 test/build 실행이나 성공을 요구하지 않는다.

| Case | 기대 결과/확인 invariant |
| --- | --- |
| 생성 재전송·다른 key·다른 user·원 session logout | 같은 요청/TTL 유지; 다른 active 요청 409; 소유 우회 0; 확정 전 logout은 삭제 0. |
| Wrong state/cookie/purpose/provider/account·stale attempt | 삭제·session 발급·revoke 0; 올바른 요청의 자격을 임의 소비하지 않음; attempt 교체 뒤 이전 callback 거절. |
| 요청 TTL 직전/정확한 경계·lock 대기 | Fresh T로 확정 가능/불가 구분; 만료 뒤 user 상태 변화 0. |
| Callback 중복·확정 commit 불명·revoke 전 crash | 원자 claim 하나, 재조회 전 revoke 0; recovery outcome unknown, 로컬 삭제는 idempotent. |
| Revoke 200/명확한 오류/invalid_token/5xx/timeout/늦은 응답 | confirmed/failed/unknown 구분; DELETE와 분리; token 영구 저장 0·중복 provider 호출 0. |
| Journal ack 유실·append 중복·저장소 불가 | deletionId idempotency, read-after-write로 확인; 확인 전 DELETE/완료 0; deleting 유지. |
| DELETE rollback/commit 유실·완료 journal 후처리 실패 | receipt 재조회로 실제 commit 확인; old UUID만 삭제; journal intent 남아 복원 부활 0, 성공을 추측하지 않음. |
| Exchange-before-delete / delete-before-exchange | 먼저 생성된 session은 cascade; 대기 요청은 400·자동 재가입 0. Callback 성공만으로 통과하지 않음. |
| Cooldown 직전/정각 생성·cooldown 중 요청 지연·fence GC | 정각 이후 새 요청만 새 user; old request는 최종 exchange 거절; 1,200초 GC 뒤 old TTL 만료. |
| Refresh/logout/reuse·계정 2단계·검색 경합 | deleting 뒤 refresh/계정 401, 인정 전/후 activity 구분, residual JWT 검색만 기존 exp까지 유지, 부활 0. |
| Receipt 오자/UUID만/JWT/재가입 계정/만료 경계/복원 | 정보 동일 404; result credential로 다른 기능·provider 요청 불가; 24시간 연장/재발급 0. |
| Cleanup 중단·24시간 pending·backup 실패 7일 초과 | 만료 자격 거절 유지, 잔여 공개·incident, 오래된 snapshot 사용 금지, 안전 evidence 없이 journal GC/복원 공개 0. |
| 삭제 전 backup·재가입 후 backup·pending intent backup | old UUID 제거·새 UUID 보존·pending intent 재적용. 모든 session/refresh/OAuth/receipt 0. |
| Journal 누락/rollback·옛 JWT key·등록 밖 copy·다른 lineage | Fail closed; 옛 credential을 허용한 cutover 0; checksum만으로 최신성 통과 금지. |
| 복원 중 late callback/worker·600초 중 신규 로그인 | Quiescence/lineage 위반 차단, provider 재호출 0, 새 로그인은 gate 해제 후 새 요청만. |
| 모든 retention/log sink | 목적별 최소 field/TTL 확인, 원문 token/subject/receipt 일반 log 0, 장기 identity 보관·무기한 정상 보관 경로 0. |

## 외부 근거와 한계

2026-09-06 공식 문서 확인: [Google OIDC revoke](https://developers.google.com/identity/openid-connect/reference)는 200/빈 body와 이미 만료·폐기된 token의 `invalid_token`, 효력 반영 지연을 설명한다. [Google server flow revoke](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke)는 **그 사용자가 해당 project에 부여한 scopes와 client들의 token**까지 영향을 설명한다. 다른 모든 사용자의 grant를 취소한다는 뜻은 아니다.

[Discord OAuth2 revoke](https://docs.discord.com/developers/topics/oauth2#token-revocation)는 client 인증과 form 전송, 해당 authorization의 연결된 active access/refresh token 폐기를 설명한다. 확인한 문서만으로 invalid/already-revoked token의 exact 응답을 성공으로 일반화하지 않는다. 공식 규격을 읽은 evidence이며 LDB의 실제 등록/credential/revoke 실행 성공은 아니다. 이 차이 때문에 remote 결과를 별도 보관하고 불명 응답의 자동 retry를 선택하지 않았다.
