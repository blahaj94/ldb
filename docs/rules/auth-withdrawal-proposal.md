---
type: rule
status: active
enforcement: approval-required
scope: account withdrawal, identity races, deletion retention and recovery
last-reviewed: 2026-09-06
rationale: cascade 밖의 탈퇴 진행 상태와 삭제 보존을 하나의 승인 가능한 정책으로 연결한다.
evidence: "PR #72 D1–D5 사용자 승인: https://github.com/blahaj94/ldb/pull/72#issuecomment-5557976162 ; 사용자 merge: 9b7777313923b31dc78075e05b0cd5169016d6fd ; 설계 근거: Issue #69, Issue #39 Proposal Revision 2"
exceptions: D1–D5는 승인됐으며 제품 구현·실제 외부/삭제/복원 실행은 별도 착수 지시와 환경 검증을 요구한다.
review-after: 승인 정책 변경, 운영 저장소 선정 또는 최초 경합·복원 통합 검증 시
---

# 탈퇴·삭제·재가입·복원 Contract

이 문서는 [PR #72의 D1–D5 전체 사용자 승인](https://github.com/blahaj94/ldb/pull/72#issuecomment-5557976162) (2026-09-06T08:17:09Z)과 사용자 merge를 반영한 **active Rule**이다. [Design #69](https://github.com/blahaj94/ldb/issues/69)의 설계 작성·독립 review 결과를 승인했으며 제품 구현과 실제 환경 검증은 별개다. [#39 최종 설계](https://github.com/blahaj94/ldb/issues/39#issuecomment-5551313691)와 [DB](auth-database.md)·[OAuth](auth-oauth.md)·[runtime](auth-runtime.md)의 탈퇴 정책 gate를 구체화한다. 기존 로그인/refresh의 검증 AC를 소급 변경하지 않으며 탈퇴 extension의 구현·통합 검증은 별도 착수 범위다. 이 문서는 제품 code·schema 실행물·운영 runbook이 아니다.

## 승인된 선택과 근거

승인된 정책은 **새 재인증으로 확정한 탈퇴를 되돌리지 않고, revoke를 한 번 시도한 뒤 외부 결과와 구분하여 LDB 데이터를 삭제**하는 것이다. 동일 계정 확인 뒤 임시 차단하고, 복원 대상 밖 삭제 intent의 내구성 확보를 취소 불가 확정점으로 삼는다. 재가입은 완료 후 600초를 기다리고 새 로그인 요청으로만 허용한다. 삭제 결과는 별도 읽기 자격으로 24시간 조회한다. 삭제 회원 UUID는 복원 차단 목적만으로 한정 보관하고 provider identity는 짧은 경합 차단에만 쓴다.

| 승인 항목 | 승인된 선택·이유 | 선택하지 않은 대안과 영향 |
| --- | --- | --- |
| D1 탈퇴 확정/취소 | 최종 확인과 동일 계정의 새 OAuth round trip 뒤 임시 차단하고, 별도 journal의 durable intent를 확정점으로 한다. Provider session 재사용은 허용한다. 준비 중에는 결과 판정까지 취소를 유보하며 확정 뒤 취소 없다. 준비 전 취소/만료는 회원 유지. 경합의 단일 기준을 만든다. | 항상 비밀번호/추가 인증을 강제하는 대안은 provider별 보장과 계정 접근 상실 복구 정책이 필요하다. 삭제 유예/복구 UI도 별도 보관·권한 설계가 필요하다. |
| D2 provider 실패 | 확정 뒤 revoke의 실패/불명도 로컬 삭제를 막지 않는다. 결과를 분리해 표시하고 삭제 뒤 자동/서버 revoke 재시도는 하지 않는다. Provider 장애가 회원 보관을 무기한 연장하지 않게 한다. | Revoke 확인 때까지 삭제 보류는 장애·계정 접근 상실 시 탈퇴를 끝내지 못한다. Token을 암호화 저장해 재시도하면 현재 비보관 정책·key·queue·보관기간을 추가로 바꿔야 한다. |
| D3 재가입/진행 로그인 | 완료 후 600초 대기, 그 이후 생성한 요청만 새 UUID·nickname·session으로 가입. 기존/대기 중 OAuth로 자동 재가입하지 않는다. 기존 login TTL 600초에 맞춘 작은 차단 구간이다. | 즉시 새 요청 재가입은 가능하지만 이전 revoke의 지연 효력과 새 동의가 더 쉽게 경합한다. 장기 차단은 provider 식별 보관을 늘린다. 600초도 provider 효력 완료를 보장하지 않는다. |
| D4 삭제 후 식별/조회 | 조회 자격은 생성부터 고정 86,400초, identity HMAC fence는 완료부터 최대 1,200초, 삭제 UUID journal은 아래 8일 정책. 재가입 계정에는 이전 결과를 연결하지 않는다. | 조회 자격 없음은 응답 유실 복구를 어렵게 한다. 장기 receipt·원문 subject tombstone은 불필요한 추적/보관을 늘린다. HMAC도 익명정보로 간주하지 않는다. 저장소 장애로 삭제 불가 시에는 기간 상한을 보장할 수 없는 격리 잔여와 복구 후 우선 삭제를 D4 장애 예외로 승인했다. |
| D5 복원/백업 | 성공 dump 최대 7개와 snapshot 나이 7일 상한을 함께 적용한다. 별도 삭제 journal 없이는 복원 공개 금지. 복원 시 전 회원 session/refresh/OAuth·receipt 무효화와 JWT key 교체, 600초 신규 로그인 중단을 수용한다. | 성공본 개수만 제한하면 백업 실패 동안 오래된 개인정보가 무기한 남는다. 선택적 session 복원은 옛 credential과 삭제 경계를 재검증하는 복잡성을 추가한다. |

D1–D5와 아래 수치/권한/한계는 위 명시적 승인으로 확정됐다. 이 수치는 법적 보관기간을 주장하지 않는 제품·운영 정책이다. 선택을 변경할 때는 의존 항목의 영향까지 포함해 다시 승인받는다. 정책 승인 뒤에도 공유 schema·기능의 후속 구현과 실제 환경 실행은 별도 착수 지시가 필요하다.

## 권한과 시간 기준

- `T`는 [session Rule](auth-session.md)의 lock 뒤 fresh UTC whole-second다. 모든 TTL은 `T >= expires_at`에 거절하며 HTTP 재시도·조회·재인증으로 연장하지 않는다. 아래 600초는 10분, 86,400초는 24시간, 604,800초는 7일, 691,200초는 8일이다.
- 요청 생성은 유효 Access JWT와 존재·소유·활성·idle 미만료 user/session을 요구한다. 원 user UUID, 원 session UUID, provider, client/등록 snapshot을 서버가 결정한다. Client의 임의 subject/user ID·email·nickname은 삭제 대상 증명이 아니다.
- 앱 main은 독립 32-byte CSPRNG `statusToken`을 canonical base64url 43자로 만들고 요청 UUID와 함께 전송한다. 서버는 strict decode한 32byte의 SHA-256만 저장한다. Request UUID 단독·JWT·refresh·새 재가입 계정·browser cookie는 이 자격을 대체하지 않는다. Raw 자격은 URL/renderer/로그에 넣지 않으며 main의 기존 보안 저장 경계에서 만료 또는 결과 확인 후 지운다. 구체적 IPC/OS 구현은 후속 범위다.
- `statusToken`은 해당 요청의 정제 상태 읽기와 이미 검증된 preparing의 결과 판정과 확정된 로컬 작업 재개만 허용한다. User/profile 조회·탈퇴 확정·새 재인증·provider 호출·다른 요청 조작·재가입 자격으로 쓰지 않는다. 유출 시 해당 탈퇴 진행 사실은 노출될 수 있으므로 credential로 취급한다.
- 동일 계정 재인증은 별도 purpose=`withdrawal`로 수행한다. 기존 OAuth의 provider snapshot, state+cookie, nonce, PKCE, identity 검증을 재사용하되 로그인 exchange code·user/session/refresh는 발급하지 않는다. 요청 목적·원 user/session·provider+subject·유효한 browser attempt를 모두 비교한다. 여기서 재인증은 새 code 교환·nonce/PKCE와 동일 identity 검증을 뜻한다. Provider session 재사용을 허용하며 비밀번호 재입력/최근 password 인증을 보장하지 않는다. Account chooser 표시만으로 통과시키지 않는다. 이 보장 수준은 D1에서 승인됐다.
- 최종 확인 화면은 취소 불가 시점, 해당 provider grant 전체에 줄 영향, revoke 미확인이어도 LDB 삭제 진행, 재가입 대기, receipt 만료를 안내한다. `confirmation="delete_account"` 제출 후 시작한 재인증이 일치해야 확정할 수 있다. Login 요청을 withdrawal로 전환하거나 callback alone으로 새 삭제 요청을 만들 수 없다.

## 상태 전이와 원자 경계

한 user에 미완결 요청은 최대 하나다. DeletionId는 requestId와 같은 UUID다. 생성부터 preparing 진입의 재인증 자격 TTL은 600초다. 그 안에 검증·준비한 작업의 journal 결과 판정은 이후에도 끝내지만 새 인증 자격을 연장하지 않는다. Browser attempt는 created/browser_started/processing의 기존 일회용 claim·proof 규칙을 사용하고 한 번 사용한 code는 재교환하지 않는다. 실패한 attempt의 새 재인증은 같은 요청의 남은 TTL 안에서 원 session이 여전히 유효할 때만 새 proof로 시작한다. 별도 provider HTTP 동안 DB lock을 잡지 않는다.

| 상태 | 진입 조건/처리 | 다음 상태·실패 결과 |
| --- | --- | --- |
| `awaiting_reauth` | 생성/최종 확인 저장. 회원은 active, 기존 기능 유지. Receipt 만료 시각은 생성+86,400초로 고정. | 재인증 성공 후보 → 아래 준비 transaction. 취소·600초 만료 → `cancelled`/`expired`. Provider 거절·계정 불일치·잘못된 proof는 회원 변화 없이 정제 실패. |
| `preparing` (임시 차단) | 요청→identity→user→원 session 잠금. TTL·attempt·원 session·동일 identity를 fresh T로 검증하고 users.lifecycle=`deleting`, prepared_at·원 대상·executor epoch를 commit한다. 아직 accepted가 아니다. | 원 session이 먼저 종료됐다면 준비 없이 거절. 이후 logout은 검증된 준비를 취소하지 않는다. DB commit 불명은 재조회한다. Provider revoke/SQL DELETE는 아직 0. |
| `preparing → deleting` (확정점) | 현재 writer generation으로 별도 journal에 `(deletionId,oldUserId,preparedAt)` intent를 durable append한다. **내구성 있는 append 자체가 취소 불가 확정**이며 ack 유실도 같은 ID 조회로 확인한다. acceptedAt/sequence를 DB에 반영한다. | 시도 전 명확한 불가면 임시 차단 해제·새 재인증 안내. 요청을 보낸 뒤 실패/불명이면 준비 유지, absence 조회만으로 rollback하지 않음. 같은 ID 로컬 재개 또는 writer를 fence한 복구 대조로 판정. Durable intent가 없다고 확정된 복구는 준비를 실패 처리한다. |
| `deleting` / revoke 종결 | Durable intent 확인 뒤 phase=revoke와 단일 claim/epoch/deadline을 CAS로 기록하고 그 claim부터 10초 단일 deadline, 자동 retry 0회. 그 deadline까지 claim 주체만 진행하고 resume는 대기 상태를 반환한다. Outcome을 `confirmed`/`failed`/`unknown`으로 저장하고 token 참조 해제. Crash/claim 후 timeout/결과 저장 유실은 `unknown`으로 수렴하며 provider 재호출 없음. | 이미 확보한 journal intent를 기준으로 로컬 삭제 진행. Provider 성공이 user 삭제 성공을 뜻하지 않음. |
| `deleting` / 로컬 재개 | Durable intent가 authority다. primary의 accepted 결과 반영이 유실됐어도 같은 oldUserId의 처리를 이어간다. Revoke claim을 이미 기록했거나 callback token을 잃었으면 다시 호출하지 않고 unknown으로 수렴한다. | SQL DELETE 전 journal sequence를 확인. DB 장애는 deleting 유지·503/처리 중. Receipt 없어도 executor가 obligation을 처리한다. |
| `completed` | journal intent 확인 후 요청→identity→user 잠금 transaction에서 대상 UUID의 user 삭제(cascade), 필요한 개인 데이터 FK 삭제, fence 갱신, completed_at 및 receipt 결과를 함께 commit. | 명확한 rollback이면 그대로 재개. Commit 응답 유실/불명은 같은 요청 조회로 확인하며 새 user/session 생성 없음. Journal에 완료 시각을 idempotent 기록하는 후처리를 이어간다. |
| `cancelled`, `expired` | `awaiting_reauth`에서만 즉시 가능. Preparing의 외부 결과 불명은 취소/만료로 바꾸지 않는다. 확정 부재가 판정되면 실패/만료로 종결한다. 재인증 proof/원 user·session 연결을 지우고 요청 ID/hash/상태/시각만 남긴다. | 같은 요청 부활 없음. 유효한 계정에서 새 요청을 생성할 수 있음. |
| receipt 만료/삭제 | 생성+86,400초 이상 또는 복원으로 자격 무효화. 완료/취소/만료 결과와 hash 삭제. | 모든 lookup은 같은 `404 WITHDRAWAL_REQUEST_UNAVAILABLE`. 미완료 로컬 삭제 obligation은 receipt와 독립해 끝내며 조회 자격을 연장하지 않음. |

Preparing 진입 전에 현재 user/session을 확인할 수 없는 DB 장애는 503이며 삭제하지 않는다. Durable intent 이후의 DB/journal 장애는 탈퇴 취소가 아니다. Primary 손실 전 준비만 commit되고 journal에 없는 요청은 확정된 탈퇴로 표시하지 않는다. 복구는 이전 writer generation을 차단한 뒤 journal 최종 결과를 판정하므로 늦은 append가 판정을 뒤집지 못한다. `completed` 응답은 로컬 DELETE와 결과 commit을 확인한 뒤만 허용한다. Provider 결과가 confirmed이면 “LDB 탈퇴 완료·연결 해제 요청 확인”, 그 외에는 “LDB 탈퇴 완료·소셜 연결 해제는 확인하지 못함”을 표시한다. 백업에는 보관 상한까지 암호화된 사본이 남을 수 있음을 구분한다.

## Revoke 결과·재개·중복

| 관측 | 저장/재시도 | 사용자 안내 |
| --- | --- | --- |
| 공식 성공 응답 | `confirmed`. 동일 요청에서 재호출하지 않음. 지연 효력 가능성 유지. | 연결 해제 요청 확인. 다른 해당 grant token에도 영향 가능. |
| 명확한 요청 거절, Google `invalid_token`, 설정/인증 오류 | `failed`. Invalid token이 특정 token의 무효를 나타내도 grant 전체 완료로 승격하지 않음. 로컬 삭제 계속. | LDB 탈퇴와 별개로 provider 설정에서 앱 연결 상태 확인/해제. |
| Timeout·연결 종료·5xx·예상 밖 응답·crash·결과 저장 실패 | `unknown`. 요청이 처리됐을 수도 있으므로 같은/새 token으로 서버 retry하지 않음. 늦은 응답이 outcome/삭제 대상을 다시 바꾸지 못함. | 소셜 연결 해제 여부 미확인. 이후 다시 동의했다면 설정에서의 수동 해제가 새 동의에도 영향을 줄 수 있음을 안내. |
| 준비 전 재인증 실패 | Provider code/token 저장 없음. TTL 내 원 session+statusToken으로 새 browser attempt 가능. | 계정 일치/새 인증을 다시 확인. 회원 유지. |
| 확정 후 앱 종료·HTTP 유실·재시작 | receipt로 조회/로컬 재개. 단일 로컬 executor가 revoke claim deadline 이후 claim/CAS로 journal append·DELETE를 반복 가능하게 처리. 동시 resume는 같은 결과, 중복 revoke 없음. | `deleting`은 처리 중이며 완료를 추정하지 않음. |

재인증의 code 교환+identity 검증에는 기존 10초/자동 retry 0을 적용한다. 확정 뒤 revoke는 별도 10초/자동 retry 0이며 callback에서만 새 token을 사용한다. 준비/journal DB 경계에서 token이 만료되거나 처리 주체가 사라지면 `unknown`으로 로컬 삭제를 계속한다. Token·provider code·raw 응답은 DB/file/queue/journal에 보관하지 않는다. 각 작업은 phase·executor epoch를 확인한 CAS만 반영한다. 새 owner는 기록된 revoke claim을 재실행하지 않고 deadline 뒤 unknown으로 처리한다. 이전 owner의 늦은 DB write는 거절하고, network에 이미 보낸 revoke의 remote 지연은 D2 한계로 남긴다. 이 추가 외부 단계와 로컬 재개 executor는 기존 로그인 callback을 확장 승인한 것으로 간주하지 않는다.

같은 `(requestId,statusToken,원 user)` 생성 재전송은 기존 상태를 반환하며 TTL·browser proof·동의를 갱신하지 않는다. 다른 key로 같은 user에 요청하면 `409 WITHDRAWAL_IN_PROGRESS`다. Key 충돌/다른 user/틀린 자격은 기존 row·account 존재를 드러내지 않는 정제 거절이다. Preparing 이후 session이 차단/삭제되면 생성 endpoint 재전송 대신 전용 status/resume를 쓴다. 재가입한 user의 새 요청은 다른 deletionId와 UUID를 가진다.

## 로그인·기능 경합의 최종 결과

Identity 직렬화 key는 길이 구분 encoding의 `(provider,subject)` HMAC-SHA-256이다. 별도 secret key/version을 DB 밖에 두고 raw subject나 단순 사전 대입 가능한 hash를 tombstone으로 남기지 않는다. 모든 exchange와 탈퇴 준비/삭제는 user 존재 여부와 무관하게 같은 identity transaction lock을 획득한다. Lock key가 충돌하면 직렬화만 늘고 full digest/identity 일치 검사 없이 계정을 합치지 않는다.

Lock 순서는 **자기 OAuth 또는 withdrawal row → identity transaction lock → user → session → refresh**다. 다른 session/cleanup 작업이 뒤에서 OAuth/withdrawal/identity lock을 잡지 않는다. 검색 활동은 기존 session-only lock을 유지한다. 탈퇴는 다른 login row를 잠가 전수 취소하지 않고 callback 완료 및 최종 exchange에서 user lifecycle/fence·TTL을 확인한다. Identity를 아직 모르는 callback은 검증 후 검사하고, 그 검사를 통과해도 exchange에서 다시 검사한다.

삭제 완료 시 fence에 `rejoinNotBefore=completedAt+600`, `expiresAt=completedAt+1200`을 저장한다. Login은 `created_at >= rejoinNotBefore`이고 fresh T도 그 이상일 때만 가능하다. 그 이전에 만든 요청은 나중에 눌러도 실패한다. Fence는 추가 600초 동안 남아 cooldown 중 생성한 login도 끝까지 거절한다. `expiresAt`에서 삭제해도 그 요청들은 원래 600초 TTL로 이미 만료다. Cleanup/재시도는 시간을 늘리지 않는다. Clock 역행/불명은 운영 fail-closed 조건이다.

| 경합 | 최종 결과 |
| --- | --- |
| Exchange가 먼저 user/session 생성 commit | 뒤의 탈퇴 준비가 같은 user를 deleting으로 바꾸고 최종 cascade한다. 늦은 token 응답도 refresh·계정 기능에 유효하지 않다. |
| 탈퇴 preparing이 먼저, OAuth/exchange가 대기 | 같은 identity의 deleting user 또는 fence를 확인해 `400 LOGIN_EXCHANGE_INVALID`/기존 callback 정제 실패. 새 user/session/refresh 생성 없음. |
| 삭제 전/중 callback이 identity 검증 완료 | Subject 검증은 회원 생성 허가가 아님. 최종 exchange의 lifecycle/fence/created_at 검사에서 거절. 신규 사용자로 자동 전환하지 않음. |
| 완료 후 600초 직전/정확한 경계 | 직전 시작 요청은 계속 실패. 경계부터 새로 생성한 요청만 재가입 가능. 새 UUID·랜덤 nickname이며 이전 receipt/session/활동과 연결하지 않음. |
| Refresh 또는 계정 기능이 preparing 전에 lock/commit | 기존 승인 결과가 먼저 완료될 수 있음. 이후 deleting을 확인한 refresh·GET/PATCH는 401, 기존 refresh 전체는 최종 cascade. Admission만 먼저 완료된 계정 기능은 기능 단계에서 lifecycle 재확인해 결과/변경 0. |
| 탈퇴 preparing 후 refresh·계정 기능 | user.lifecycle 검사에서 401, 새 token·조회·nickname 변경 없음. 탈퇴/status/revoke는 session 활동이 아님. |
| Logout·refresh reuse·session cleanup | 기존 session별 의미를 유지. Preparing 진입 전에 원 session이 끝나면 준비 실패. Preparing 이후 logout/만료는 journal 판정을 취소하지 않으며 durable intent가 있으면 삭제, 부재를 확정한 복구는 미확정 종결. |
| 검색과 deleting/삭제 | 기존 residual 정책 유지: 유효 JWT의 검색은 exp까지 가능, session-only 활동을 먼저 기록할 수 있지만 삭제가 cascade함. 검색으로 user/session 재생성 없음. 이 정책은 JWT 즉시 검색 차단을 약속하지 않음. |
| 신규 재가입 후 늦은 기존 executor/receipt | 삭제 대상 oldUserId만 사용하고 provider identity로 현재 user를 찾아 DELETE하지 않음. 새 user와 session 보존, 서버 revoke 재시도 없음. |

## 최소 state/schema/API 변경

아래는 승인된 논리 schema이며 EntitySchema/SQL/Migration 구현 완료를 뜻하지 않는다. 새 dependency는 포함하지 않는다. Index·CHECK·Migration은 후속에서 이 상태별 null·단일성·잠금 의미를 검증해야 하며 새로운 보관 field를 임의로 늘릴 수 없다.

| 대상 | 최소 변경 |
| --- | --- |
| `users` | `lifecycle=active\|deleting`, nullable `withdrawal_id`의 일관된 pair. Deleting 동안 identity unique는 유지. 기존 ID 재사용 없음. |
| `auth_withdrawals` (신규) | 요청 UUID PK, nullable statusToken hash UNIQUE(존재 시 32byte; receipt 만료 때 null), status, prepared/accepted/completed 및 TTL 시각, receipt deadline, phase(`prepare/intent/revoke/local_delete/complete`), 단조 executor_epoch·claim_deadline, 원 user/session UUID·provider/client/config binding, revoke outcome/claim 시각, journal sequence. Phase/epoch를 조건부 UPDATE와 연결하고 completed 재실행은 fence/결과를 다시 쓰지 않는다. User FK cascade를 두지 않고 최종 결과를 분리. 미완결 user당 unique. Proof는 상태별 nullable·terminal 즉시 제거. |
| 재인증 transient field | 위 withdrawal row의 별도 attempt ID와 launch/state/browser/nonce hash·암호화 PKCE·attempt 상태/TTL. 기존 OAuth와 동일 entropy/AAD에 purpose/attempt binding 추가. 원문 provider subject는 users에서 비교하고 이 row에 복제하지 않음. 최종 callback은 로그인 code를 발급하지 않음. |
| `auth_identity_fences` (신규) | HMAC digest+key version PK, rejoin_not_before, expires_at. FK/원 user UUID/원문 subject 없음. 필요한 기존 user identity는 삭제 transaction 메모리에서만 HMAC으로 변환. |
| 복원 control store (신규 운영 state) | 삭제 journal의 단조 sequence·deletionId unique·oldUserId·preparedAt/acceptedAt·완료 확인 시각, durable writer generation·현재/직전 checkpoint, 승인된 backup inventory의 snapshot 시각/만료/폐기 evidence·journal checkpoint. Auth DB 복원으로 되감지 않는 독립 volume/권한 경계. 현재 writer generation만 append 가능하며 복원/owner 교체 때 atomic fencing한다. Provider identity·token·receipt hash 없음. |

| 승인된 탈퇴 API | 자격·정제 결과 |
| --- | --- |
| `POST /auth/withdrawal-requests` | JWT + `{requestId,clientId:"desktop",statusToken,confirmation:"delete_account"}`. 201 `{requestId,status,reauthUrl,reauthExpiresAt,receiptExpiresAt}`. 같은 key의 재전송 200, 소비된 launch URL은 재발급하지 않음. |
| `POST /auth/withdrawal-requests/:id/reauthorize` | 원 user/session JWT + `{statusToken}`. `awaiting_reauth`의 남은 TTL에 새 일회용 browser attempt를 201로 제공. 이전 attempt는 무효화. Preparing 이후 거절. |
| Browser authorize/callback | purpose 전용 launch 및 provider callback 등록/분기. URL은 launch ticket/state/code만, statusToken 없음. 기존 state+cookie와 새 purpose-bound OAuth 결과 확인 후 상태 machine 진행. 성공 HTML은 정제 결과·앱 복귀 안내만, token/receipt/user ID 없음. |
| `POST /auth/withdrawal-requests/:id/status` | `{statusToken}`만으로 200 `{status,revokeOutcome,receiptExpiresAt,completedAt?,rejoinNotBefore?}`. Profile/subject/user/session ID·provider 원문 오류 없음. POST로 secret의 URL 노출을 피함. |
| `POST /auth/withdrawal-requests/:id/resume` | `{statusToken}`. 준비/journal 결과 판정 및 이미 확정된 로컬 삭제만 202 처리 중 또는 200 완료 상태. Awaiting 상태는 409. 새 provider 요청/새 인증 권한 없음. |
| `POST /auth/withdrawal-requests/:id/cancel` | 원 user/session JWT + `{statusToken}`. `awaiting_reauth`만 200 cancelled; 준비/확정 경합에서 늦으면 409. |

모든 JSON은 [API Rule](auth-api.md)의 HTTPS·16,384byte pre-parser·no-store·allowlist log를 따른다. JWT 필요 endpoint는 pre-parser→JWT→fields→DB의 기존 순서다. Status-only endpoint는 pre-parser→field 형식→constant-time hash 비교·TTL→상태로 검사한다. 형식 오류 400, 유효 형식의 absent/wrong/expired credential은 동일 `404 WITHDRAWAL_REQUEST_UNAVAILABLE` (“탈퇴 요청을 확인할 수 없습니다.”), 조건 불일치는 `409 WITHDRAWAL_IN_PROGRESS` (“탈퇴 요청의 현재 상태를 확인해 주세요.”), 기존 인증 실패 401·DB/control store 일시 장애 503이다. Raw URL/body/credential·식별 field를 새 log sink에 추가하지 않는다. 인증 전 abuse 수치는 기존 미결정 운영 gate에 연결한다.

## 보관과 삭제

아래 기한은 용도 종료/정리 eligibility와 운영 목표다. 장애 중 물리 삭제 성공을 시간 경과만으로 주장하지 않는다. TTL 연장·조사 목적 보존·manual hold를 정상 경로에 두지 않는다. 신뢰할 cleanup/관측/폐기 evidence가 없는 환경은 이 보관 정책의 운영 준비 완료가 아니다.

| 정보 | 목적·최소 보유 | 기한과 삭제 조건 |
| --- | --- | --- |
| 현재 회원 데이터·sessions·refresh | 확정 전 서비스, 확정 후 old UUID 삭제에 필요한 기존 데이터 | 정상 flow에서 revoke 최대 10초와 journal ack 뒤 바로 원자 삭제. 준비부터 24시간 내 완료/미확정 종결 목표. 초과는 incident·서비스 담당 개입, 확정 user의 active 복구 금지. 실제 DB 불가 시 지연을 공개하고 성공으로 표시하지 않음. |
| 재인증 proof/원 user·session binding | 한 요청의 동일 계정·목적 확인 | Proof는 attempt 종결/취소/600초 만료 때 null. 확정 뒤 새 인증 불가. User/session binding은 DELETE 완료 때 null; 미완료 intent 처리에 필요한 oldUserId만 분리 보유. Provider token은 callback 메모리에서 finally 해제, crash zeroization 보장 없음. |
| Receipt | 요청 ID, credential hash, 정제 상태/revoke 결과·최소 시각 | 생성+86,400초에 접근 종료·삭제. 완료 때 새 24시간을 시작하지 않음. Receipt 유실/만료/복원 뒤 재발급·provider 로그인으로 이전 상태 복구 없음. 미완료 obligation에는 credential 불필요. |
| Identity fence | Provider identity HMAC·key version와 두 deadline, 자동 재가입 차단 | 완료+1,200초에 삭제. 완료+600초부터 새 로그인 허용. Lock/fence는 단일 active key를 공유하며 정상 교체는 모든 fence 만료/삭제와 관련 transaction drain 뒤만 허용. 유실 시 탈퇴/exchange를 멈추고 pending login 전부 무효화·진행 삭제 대조 뒤 600초 admission 중단 후 새 key 사용. |
| 삭제 journal | oldUserId, deletionId, sequence·accepted/완료 시각만. 복원 부활 차단 | 완료 확인+691,200초 보관. 그때 관련 모든 snapshot이 7일 한계 밖이며 승인 inventory에서 제외·실제 폐기됐음을 확인 후 segment compaction으로 UUID 제거. 미완료 intent는 완료시각을 조작해 만료시키지 않음. 24시간 이상 pending/폐기 실패는 아래 D4 장애 예외로 격리. 안전한 삭제/복원 증명을 회복하기 전 공개 복원 금지. |
| Backup 사본·임시 dump/restore DB·복제본 | 승인된 암호화 recovery 사본. 모든 사본의 inventory/소유자 필수 | 성공본 최대 7개 AND 각 snapshot 시각+604,800초 미만. 실패 dump 즉시 삭제, restore scratch는 검증/실패 종료 때 삭제. Snapshot 나이는 복사/restore/re-backup으로 리셋하지 않음. 새 성공본이 없어도 만료본 사용·보관 연장 없음. |
| Inventory·폐기 evidence | snapshot ID/원 snapshot 시각·lineage·폐기 시각·정제 결과만 | Snapshot 시각+15일에 삭제. Failed dump/restore scratch evidence는 종료+8일. 장애로 폐기 미확인이면 D4 예외에 포함하고 새 snapshot으로 나이를 리셋하지 않음. |
| Checkpoint·writer generation | 현재/직전 sequence·generation·무결성 증거, 개인정보 field 없음 | 현재 값은 서비스 수명 동안 단일 값으로 유지·교체 시 직전 값만 최대 8일 뒤 삭제. 서비스 폐기 때 전부 삭제. UUID를 포함한 옛 segment 사본 보관은 금지. |
| 운영 log | 개인식별 없는 route template·결과 code·duration·집계 | 7일 뒤 삭제. User/deletion/request UUID·HMAC·receipt·provider raw 응답은 기록하지 않음. 장애 잔여는 D4 예외에 포함. |

**D4 장애 예외는 승인됐다.** 저장소 접근/폐기·key 파괴가 불가능하면 물리 잔여에는 유한 상한을 보장하지 못한다. 이를 숨긴 24시간/8일 삭제 보장을 약속하는 대신, 확인 가능한 삭제까지 필요한 최소 데이터만 격리하고 접근 권한 TTL은 그대로 종료하며 unsafe 복원/계정 재활성화를 금지하는 정책이다. 24시간 초과부터 책임자가 사용자에게 미완료/지연을 안내하고 매 24시간 incident 상태·복구/폐기 경로를 재검토한다. 복구 시 다른 서비스 재개보다 삭제·compaction을 먼저 실행하고 완료 evidence 뒤 잔여를 없앤다. 조사·사업 목적의 임의 hold는 없다. 이 예외를 수용하지 않는 정책으로 변경하려면 독립 crypto-erasure/매체 파괴로 hard limit을 충족하는 운영 수단을 먼저 설계·승인해야 하며 그 전 해당 정책으로 탈퇴 운영을 출시할 수 없다. 실제 매체 접근 자체가 불가능한 경우에는 그 대안도 검증 없이 삭제 성공으로 표시할 수 없다.

## 삭제를 보존하는 복원 기준과 순서

복원 허용 조건은 **복원할 사본의 신뢰할 snapshot 시각/lineage + 현재 시점까지 누락 없는 별도 삭제 journal + 외부 checkpoint의 rollback 불가 확인**이다. 단순 checksum은 변조/되감기 부재 증명이 아니다. Journal과 최신 checkpoint/inventory는 auth DB의 restore 범위 밖에 있어야 하며 실제 저장 매체·내구성 ack·권한·동시 장애 범위는 운영 gate다. 같은 DB dump 안 tombstone만 복원하거나 최신 journal을 잃은 채 “백업 성공”만 확인해 공개하지 않는다. 외부 백업 서비스 도입은 승인 범위에 포함하지 않는다.

1. 유지보수 gate로 API ingress·background executor·callback·exchange·refresh·account 쓰기와 기존 process를 멈춘다. Control store의 writer generation을 먼저 바꿔 이전 executor의 append를 fence하고 journal을 최종 대조한다. Preparing/accepted/완료를 durable intent로 판정한다. Primary에서만 preparing이었고 최종 journal에 없으면 미확정 실패이며 복원 user를 탈퇴 완료로 오표시하지 않는다. Journal 최신성/old writer 차단을 증명할 수 없으면 복원을 시작하지 않는다.
2. 별도 DB에 나이 7일 미만인 승인 snapshot만 복원한다. 전체 journal checkpoint/연속성·pending intent와 backup lineage를 확인한다. 누락·복제본 미등록·clock 불명·journal/storage 손실은 fail closed이며 임의로 옛 DB를 공개하지 않는다.
3. 복원 DB에서 journal의 **모든 관련 intent oldUserId**에 해당하는 user와 현재/향후 개인 데이터 FK를 삭제한다. 완료 표시가 없는 intent도 사용자 확정 뒤의 삭제 obligation이므로 적용한다. 재가입한 새 UUID는 보존하고 provider+subject로 새 user를 찾아 삭제하지 않는다. 복원 snapshot의 deleting user는 preparing이면 최종 journal로 확정/실패를 판정한다. Preparing만 있고 intent 부재가 증명됐으면 원 user를 active로 되돌리되 모든 session은 다음 단계에서 폐기한다. Accepted/deleting인데 intent가 없는 불일치는 중단한다.
4. 복원된 모든 auth_sessions/refresh, auth_login_requests, withdrawal proof/receipt·identity fence를 제거한다. 이전 receipt를 복원해서 조회 자격을 되살리지 않는다. 미확정 preparation은 폐기하고 확정된 삭제 obligation은 journal에서만 재처리하며 provider revoke를 재실행하지 않는다. 전 회원은 재로그인이 필요하다.
5. DB 밖 새 ES256 signing key/kid와 새 provider PKCE key·fence HMAC key를 만들도록 운영 절차를 준비한다. 모든 이전 Access JWT verify key를 제거한 새 auth lineage를 전체 verifier에 적용한다. 기존 key와 900초 overlap을 주면 residual JWT가 살아남으므로 복원에는 정상 key rotation의 overlap을 적용하지 않는다. 실제 생성/등록은 별도 허가된 운영 실행이다.
6. 참조 무결성, old UUID 부재, 활성 session/refresh/OAuth/receipt 0, 옛 JWT/refresh/code 거절, 새 가입 시 새 UUID 보존을 격리 검증한다. 삭제 재적용 뒤 만든 사본만 새 lineage로 승격할 수 있고, 검증 전 restore DB를 backup해 원래 데이터 나이를 세탁하지 않는다.
7. 마지막 journal 대조 시점부터 600초 동안 login admission을 닫아 삭제 직후 cooldown을 전역으로 보존한다. 그동안 새 intent가 생기면 quiescence 실패로 다시 대조한다. 전 process의 새 key·lineage 및 검증 완료를 확인한 뒤 cutover한다. 실패하면 유지보수 상태를 유지하고 이전 snapshot으로 자동 복귀하지 않는다. 이전 primary도 격리/폐기 대상으로 관리한다.

이 절은 복원 설계 matrix이며 실행 성공 evidence가 아니다. Journal이 되감기거나 전체 저장소를 잃은 상황의 recovery point/손실 수용은 미결정이다. 증명할 수 없는 auth 데이터로 서비스를 재개하는 예외는 승인하지 않는다.

## 기존 contract 변경점·후속 연결점·환경 gate

| 기본 contract | 승인된 탈퇴 extension과 후속 구현 경계 |
| --- | --- |
| [auth-database.md](auth-database.md): 4개 auth table, cascade와 삭제 gate | lifecycle·withdrawal/fence·복원 journal 도입, identity lock 선행·상태별 null/unique·cleanup·Migration matrix 갱신. 기존 4-table 검증을 지금 실패 처리하지 않음. |
| [auth-oauth.md](auth-oauth.md): login-only, callback 10초, token 비보관·탈퇴 원칙 | 별도 withdrawal purpose·새 OAuth round trip·같은 계정 확인·추가 revoke deadline, 실패/불명에도 삭제하는 선택. Login callback retry/TTL은 유지. |
| [auth-api.md](auth-api.md)·[auth-session.md](auth-session.md)·[auth-activity.md](auth-activity.md) | 새 endpoint/읽기 자격/404·409, deleting lifecycle 검사. Refresh/계정 기능 차단과 검색 residual 허용 구분. **auth-session.md의 정상 900초 key overlap에 대한 복원 전용 예외**를 승인 반영: 전 verifier의 옛 key 제거 확인 전 ingress 금지, 일부 process만 새 key인 cutover 금지. |
| [desktop-auth.md](desktop-auth.md)·[desktop-auth-lifecycle.md](desktop-auth-lifecycle.md) | 기존 login의 memory-only pending·status/polling 없음은 유지. Withdrawal 전용 main 보관 statusToken·정제 IPC/state·재시작 결과 조회를 추가하는 별도 확장. 아래 최소 연결안을 후속 Rule에 조율해 반영. |
| [auth-runtime.md](auth-runtime.md), #37/#39 백업 방향 | 개수 외 7일 age cap·별도 control store·복원 gate·전원 logout. 실제 topology·durability·clock·retention 실행·운영 key 절차는 여전히 미확인. |

후속 구현의 연결 위치는 `apps/api/src/auth/login/callback.ts`, `apps/api/src/auth/login/exchange.ts`, `apps/api/src/auth/identity-session.ts`, `apps/api/src/database/schemas/`, `apps/api/src/database/migrations/`다. 이 Rule 반영은 해당 제품 파일의 변경·구현 완료를 뜻하지 않는다. 기존 로그인/refresh 기반과 deleting/withdrawal/fence의 별도 구현 착수·통합 gate를 구분하며, 탈퇴 extension이 해당 기존 작업에 구현됐다고 가정하지 않는다.

승인된 Desktop 최소 연결은 main이 withdrawal requestId/statusToken/receipt deadline만 기존 암호화 저장 경계에 별도로 보관하고 renderer에는 정제 phase/result만 보내는 것이다. 서버 등록 browser HTML은 “앱으로 돌아가 상태 확인”을 안내하며 신규 deep-link credential을 추가하지 않는다. 자동 polling 없이 사용자 상태 확인 gesture와 재시작 시 1회 status 조회만 허용한다. Preparing/deleting 진입을 확인하면 기존 local auth/capture를 정리하고 receipt만 남기며, 확인 실패는 완료로 처리하지 않는다. Local delete 실패는 기존 storageBlocked 경계다. Receipt 만료/완료 확인 때 저장물을 제거하고 원 user나 재가입 계정에 다시 묶지 않는다. 새 feature IPC 이름·sender 검증·OS 실행은 후속 승인 Rule/구현 범위이며 일반 로그인 설계를 다시 만들지 않는다.

D1–D5 승인은 완료됐으며 관련 Rule과 `docs/README.md`는 이 canonical 문서로 연결한다. 후속은 승인된 공유 schema·admission/정리/복원 state 구현 → 재인증/revoke·탈퇴 API와 Desktop 완료 조회 연결 → 경합·부분 실패·복원 통합 검증 순서다. 각 단계는 별도 bounded 범위와 착수 지시를 확인하며 이 Rule로 새 Issue나 Worker를 자동 배정하지 않는다. 기존 Google/login/refresh 작업의 AC를 소급 변경하지 않는다.

운영 미결정 gate는 provider별 실제 callback/client 등록·동일 계정 재인증과 취소의 UI 검증·revoke 응답/권한·project grant 공유 영향, Discord PKCE gate, control store의 auth DB와 독립된 내구성/rollback 감지·권한, 모든 사본 inventory·암호화/폐기, single-writer/clock·24시간 장애 대응 책임자, 실제 재인증/복원 E2E와 platform이다. 위 정책 승인을 환경 확보/실행 검증 완료로 해석하지 않는다. 실제 credential·provider 호출·삭제·복원은 별도 허가된 운영 범위에서만 수행한다.

## Validation matrix — 설계 검토와 후속 실행 구분

각 행의 기대 결과는 설계 문서와 독립 review로 검토한 승인 기준이다. 문서 검증은 link/구조/diff scope/whitespace를 확인한다. 아래 runtime·DB·provider·restore case는 별도 착수한 후속 구현 검증 항목이며 Rule 승인이나 문서 정합화의 test/build 성공 evidence로 취급하지 않는다.

| Case | 기대 결과/확인 invariant |
| --- | --- |
| 생성 재전송·다른 key·다른 user·원 session logout | 같은 요청/TTL 유지; 다른 active 요청 409; 소유 우회 0; preparing 진입 전 logout은 준비/삭제 0. Preparing 뒤 logout은 journal 판정을 유지하고 durable intent가 있으면 삭제, 부재 확정은 미확정 종결. |
| Wrong state/cookie/purpose/provider/account·stale attempt | 삭제·session 발급·revoke 0; 올바른 요청의 자격을 임의 소비하지 않음; attempt 교체 뒤 이전 callback 거절. |
| 요청 TTL 직전/정확한 경계·lock 대기 | Fresh T로 preparing 진입 가능/불가 구분; 진입 전 정확한 만료는 user 변화 0. TTL 안에 preparing된 작업은 이후 만료에도 journal 판정을 끝내며 intent 존재 시 삭제/부재 확정 시 미확정 종결. |
| Callback 중복·preparing commit 불명·journal 전 primary 손실 | 원자 준비 하나, journal 확인 전 revoke/DELETE 0; old writer fencing 후 intent 부재는 미확정 실패, durable intent 존재는 삭제 완료로 수렴. |
| Revoke 200/명확한 오류/invalid_token/5xx/timeout/늦은 응답 | confirmed/failed/unknown 구분; DELETE와 분리; token 영구 저장 0·중복 provider 호출 0. |
| Journal ack 유실·append 중복·저장소 불가 | deletionId idempotency, read-after-write로 확인; 확인 전 revoke/DELETE/완료 0; preparing 유지. 늦은 이전 epoch write 0. |
| DELETE rollback/commit 유실·완료 journal 후처리 실패 | receipt 재조회로 실제 commit 확인; old UUID만 삭제; journal intent 남아 복원 부활 0, 성공을 추측하지 않음. |
| Exchange-before-delete / delete-before-exchange | 먼저 생성된 session은 cascade; 대기 요청은 400·자동 재가입 0. Callback 성공만으로 통과하지 않음. |
| Cooldown 직전/정각 생성·cooldown 중 요청 지연·fence GC | 정각 이후 새 요청만 새 user; old request는 최종 exchange 거절; 1,200초 GC 뒤 old TTL 만료. |
| Refresh/logout/reuse·계정 2단계·검색 경합 | deleting 뒤 refresh/계정 401, 인정 전/후 activity 구분, residual JWT 검색만 기존 exp까지 유지, 부활 0. |
| Receipt 오자/UUID만/JWT/재가입 계정/만료 경계/복원 | 정보 동일 404; result credential로 다른 기능·provider 요청 불가; 24시간 연장/재발급 0. |
| Cleanup 중단·24시간 pending·backup 실패 7일 초과 | 만료 자격 거절 유지, 잔여 공개·incident, 오래된 snapshot 사용 금지, 안전 evidence 없이 journal GC/복원 공개 0; D4 예외의 상한 미보장 공개·주기적 대응. |
| 삭제 전 backup·재가입 후 backup·pending intent backup | old UUID 제거·새 UUID 보존·pending intent 재적용. 모든 session/refresh/OAuth/receipt 0. |
| Journal 누락/rollback·옛 JWT key·등록 밖 copy·다른 lineage | Fail closed; 옛 credential을 허용한 cutover 0; checksum만으로 최신성 통과 금지. |
| 복원 중 late callback/worker·600초 중 신규 로그인 | Quiescence/lineage 위반 차단, provider 재호출 0, 새 로그인은 gate 해제 후 새 요청만. |
| 모든 retention/log sink | 목적별 최소 field/TTL 확인, 원문 token/subject/receipt 일반 log 0, 장기 identity 보관·임의 hold 0; 물리 상한 미보장 장애 예외가 승인/incident evidence와 구분됨. |

## 외부 근거와 한계

2026-09-06 공식 문서 확인: [Google OIDC revoke](https://developers.google.com/identity/openid-connect/reference)는 200/빈 body와 이미 만료·폐기된 token의 `invalid_token`, 효력 반영 지연을 설명한다. [Google server flow revoke](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke)는 **그 사용자가 해당 project에 부여한 scopes와 client들의 token**까지 영향을 설명한다. 다른 모든 사용자의 grant를 취소한다는 뜻은 아니다.

[Discord OAuth2 revoke](https://docs.discord.com/developers/topics/oauth2#token-revocation)는 client 인증과 form 전송, 해당 authorization의 연결된 active access/refresh token 폐기를 설명한다. 확인한 문서만으로 invalid/already-revoked token의 exact 응답을 성공으로 일반화하지 않는다. 공식 규격을 읽은 evidence이며 LDB의 실제 등록/credential/revoke 실행 성공은 아니다. 이 차이 때문에 remote 결과를 별도 보관하고 불명 응답의 자동 retry를 선택하지 않았다.
