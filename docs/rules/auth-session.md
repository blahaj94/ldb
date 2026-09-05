---
type: rule
status: proposed
enforcement: approval-required
scope: apps/api access JWT refresh and session lifecycle
last-reviewed: 2026-09-05
rationale: 기기별 만료·rotation·재사용의 최종 상태를 시간과 transaction 경합까지 정의한다.
evidence: "Issue #39 Proposal Revision 2: https://github.com/blahaj94/ldb/issues/39#issuecomment-5551313691"
exceptions: 미승인 proposal이며 key 주기와 활동 분류도 승인 대상이다.
review-after: 최초 session 경합 validation 또는 key 정책 변경 시
---

# Session and Token Proposal

이 문서 전체는 미승인 proposal이다. API는 [`auth-api.md`](auth-api.md), DB/잠금/보관은 [`auth-database.md`](auth-database.md), 활동·잔여 JWT 검색은 [`auth-activity.md`](auth-activity.md)가 canonical contract다. 각 성공 로그인은 별도 기기 session을 만들고 한 session의 활동/logout/reuse가 다른 기기를 변경하지 않는다.

## 시간과 idle 만료

- 서버 UTC **정수 초**를 쓴다. DB row lock 획득 뒤 `clock_timestamp()`의 epoch seconds를 floor한 fresh `T`를 읽어 whole-second `timestamptz`로 저장한다. Client time이나 transaction 시작 시각인 CURRENT_TIMESTAMP/now()로 lock 대기 뒤 만료를 판단하지 않는다.
- `idleDeadline=last_active_at+2,592,000초`(30×24시간)이며 calendar month·timezone/DST 기준이 아니다. `T>=idleDeadline`은 만료다. 만료부터 확인하므로 활동/refresh가 session을 부활시키지 못한다.
- 최초 last_active_at은 성공한 앱 exchange의 session 발급 시각이다. 인정한 활동만 이전 값보다 뒤로 가지 않게 갱신한다. Refresh는 갱신하지 않는다.
- 다른 기기 활동이나 반복 refresh는 해당 session의 deadline을 연장하지 않는다. API/DB clock 동기화·역행 감지는 운영 검증 대상이고 양의 leeway로 15분/30일 상한을 늘리지 않는다.

## Access JWT

| 구분 | 필수 contract |
| --- | --- |
| Protected header | `alg:"ES256"`, `typ:"at+jwt"`, 등록된 `kid` |
| Claims | 고정 `iss`, 고정 단일 API `aud`, 내부 user UUID `sub`, session UUID `sid`, 정수 `iat`·`exp`, 임의 UUID `jti` |
| 발급 | `iat=T`, `exp=min(T+900,idleDeadline)`; `exp<=T`이면 발급하지 않음 |
| 검증 | Signature, exact issuer/audience/type, allowlisted alg/kid, 모든 필수 claim type/UUID, `iat<=now<exp`, `0<exp-iat<=900` |

Provider subject·nickname·email·기기 정보를 넣지 않는다. nbf를 사용하지 않고 임의 token의 nbf로 검증을 느슨하게 하지 않는다. 정수 초로 실제 처리 시각보다 1초 미만 일찍 만료될 수 있으나 상한을 초과하지 않는다. 이미 발급한 exp는 활동/refresh로 늘어나지 않는다.

JWT verify 자체는 session revocation DB 조회를 하지 않는다. 검색 활동과 계정 API의 존재/활성 확인은 통합 계층에서 수행한다. Logout/reuse/탈퇴 뒤에도 exp까지 검색 가능한 residual 정책은 DB 장애 시 검색 성공 보장을 뜻하지 않는다. Google ID Token과 자체 JWT의 issuer/audience/type/key/algorithm은 분리한다.

## Signing key lifecycle

Key를 boot마다 생성하지 않는다. 운영 secret 저장소/배포 secret file에 두고 source·DB·image layer·log에 넣지 않는다. **90일마다 새 signing key**와 충분히 임의인 새 kid, active signing key 하나·verify key 여러 개를 제안한다.

새 public key를 verifier에 먼저 배포 → signer 전환 → 이전 key의 마지막 발급 후 최소 900초 경과와 이전 token 만료 확인 → 이전 private/public key 제거 순서다. 침해 시 해당 kid를 즉시 제거해 JWT를 거절하며 정상 logout의 지연 허용과 구분한다. Refresh hash를 signing key에 결합하지 않는다. Key 누락·중복 kid·알고리즘 불일치는 listen 전 정제 실패다. 90일 주기와 실제 운영 교체 절차는 승인 대상이다.

## Refresh transaction

`randomBytes(32)`를 canonical base64url로 발급한다. Strict decode/re-encode로 32byte를 확인한 뒤 그 값의 SHA-256을 검증 key로 사용한다. Password용 느린 hash와 구분하고 pepper를 추가하지 않는다. DB hash 자체를 원문 credential로 받지 않는다. Random 충돌 시 전체 transaction rollback과 새 random 처리를 사용하며 uniqueness를 약화시키지 않는다.

1. Raw token hash의 초기 조회는 소유 user/session을 찾기 위한 hint다. user→session→token 잠금 후 fresh T로 hash 존재·소유·FK·상태를 다시 확인한다.
2. User/session 없음, revoked, 정확한 idle 만료 이상이면 401이며 발급하지 않는다.
3. 유효 session의 해당 발급 hash가 consumed면 revoked_at/reason=`refresh_reuse`를 commit한 뒤 401이다. 임의/미발급 hash로 대상 session을 폐기하지 않는다.
4. Current이면 새 raw token/JWT 준비 → 기존 consumed_at 갱신 → 새 hash insert를 한 transaction으로 처리한다. Signing/insert 실패는 기존 소비도 rollback한다.
5. Commit 확인 후에만 새 token을 응답한다. Refresh 자체는 last_active_at을 쓰지 않는다. 앱은 session당 single-flight 결과를 공유하고 grace/idempotent token 재전달은 없다.

## Logout과 경합의 최종 상태

Logout은 제출한 known current/consumed refresh의 session만 잠그고 폐기한다. Access JWT가 만료돼도 가능하며 이미 종료/삭제/unknown은 204다. DB 장애는 503이고 확인하지 못한 서버 logout 성공을 표시하지 않는다. 새로운 user/session ID 입력이나 JWT만으로 계정/session을 생성하지 않는다.

| 경합/실패 | 완결된 기대 상태 |
| --- | --- |
| Current R0 동시 A/B | A가 R0 소비→R1 저장으로 200일 수 있음. B는 consumed R0 재사용 폐기를 commit하고 401. **B 종료 뒤 R1도 401**이며 남은 미소비 row는 session revoked로 무효. A JWT의 residual 검색은 exp까지 가능. |
| B의 폐기 전 R1→R2 | R2가 먼저 발급돼도 B 폐기 뒤 최종 무효. B 뒤 lock 획득이면 발급 없이 401. |
| Refresh 먼저, logout 나중 | Refresh token이 생성됐어도 logout commit 뒤 무효. 늦은 HTTP 200은 현재 session 유효성을 뜻하지 않음. |
| Logout 먼저, refresh 나중 | 새 token 발급 없이 401. 다른 기기 session 유지. |
| Rotation rollback | R0 current 유지, R1 저장/응답 없음. 다음 R0 사용 성공 가능. |
| Commit 성공, 응답 유실 | R0 재사용으로 session 폐기 가능. 공격으로 단정하지 않고 새 로그인. Grace 없음. |
| Commit 결과 불명 | 성공/rollback을 추정하지 않고 503/연결 실패. 같은 raw token 자동 retry는 replay를 만들 수 있고 보관 token이 불명확하면 새 로그인. |
| Unknown hash·임의 sid/user ID | Target session 선택 credential 아님. Unknown refresh 401, logout 204, 다른 session 변화 없음. |
| 활동이 경계 전 lock·판정·commit | Refresh는 갱신한 deadline으로 검증. |
| 경계 전 요청 시작, lock 획득 시 경계 이상 | Fresh T로 401. 활동·rotation으로 부활 없음. |
| Logout 먼저, 검색 활동 나중 | JWT가 유효하면 정상 DB에서 residual 검색, revoked_at/last_active_at 변경 없음. |
| User 삭제와 refresh/계정 기능 | 관련 잠금으로 삭제 전에 완료하거나 삭제 후 없음/401. 삭제한 identity를 JWT로 복원하지 않음. Pending OAuth·탈퇴 orchestration은 별도 gate. |

활성 session의 전체 발급/소비 이력은 보존하고 종료 뒤 정리는 [`auth-database.md`](auth-database.md)를 따른다. 30일 활동 기준을 absolute session lifetime으로 바꾸지 않는다.

근거는 #39가 2026-09-05에 검토한 [PostgreSQL 시간 함수](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT), [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html), [Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)다. 시간·경합·key rotation의 실행 성공 evidence가 아니다.
