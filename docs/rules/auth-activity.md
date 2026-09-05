---
type: rule
status: proposed
enforcement: approval-required
scope: apps/api authenticated search and account activity
last-reviewed: 2026-09-05
rationale: 인증·입력·quota 거절과 활동 기록 및 DB 장애의 순서를 함께 정의한다.
evidence: "Issue #39 Proposal Revision 2: https://github.com/blahaj94/ldb/issues/39#issuecomment-5551313691"
exceptions: 기존 no-queue의 내부 admission 대기 허용 여부는 명시적 사용자 승인 전까지 미구현 선택 지점이다.
review-after: 최초 DB latency·취소·동시성 integration validation 시
---

# Authentication Activity Proposal

이 문서 전체는 미승인 추가 proposal이다. [`character-search.md`](character-search.md)의 기존 예약 시각·60초 window·무환불·즉시 upstream·단일 process 한계를 유지하면서 인증/활동을 통합할 승인안이다. **기존 “대기열은 없다”가 아래 내부 DB 직렬화 대기까지 허용한다는 해석은 아직 승인되지 않았다.** 이를 금지하는 의미로 결정하면 아래 권고안을 구현하지 않고 대안을 다시 선택한다. 현재 code와 승인 Rule의 behavior 충돌을 발견했다는 뜻은 아니다.

JWT/시간은 [`auth-session.md`](auth-session.md), API/입력은 [`auth-api.md`](auth-api.md), 잠금/정리는 [`auth-database.md`](auth-database.md)를 따른다. Authentication guard에 user 존재/revocation DB 조회를 추가하지 않으며 순수 search adapter는 인증·DB·활동을 import하지 않는다. 검색 결과는 저장/캐싱하지 않는다.

## 검색 admission 순서

1. JWT → 기존 raw query → 호출 설정 순서로 검증한다. 무효 auth+invalid query는 401, 유효 auth+invalid query+quota full은 400이다. 이 단계 거절은 quota·활동·upstream 0이다.
2. Account(`JWT.sub`)별 **admission만 직렬화**한다. 다른 account는 독립적이고 새 worker/queue/공유 저장소 dependency를 뜻하지 않는다. Quota가 풀릴 때까지 기다리거나 재시도하지 않는다.
3. 직렬화 구간에서 monotonic clock으로 최근 예약을 prune/count해 capacity를 확인하되 아직 예약하지 않는다. 10개면 활동 DB를 쓰지 않고 기존 429/Retry-After다. 같은 account의 다른 reserve가 진입하지 못하므로 통과 후 capacity는 시간 만료로 늘어날 수만 있다.
4. `sid AND user_id=sub`로 session row를 잠근 뒤 fresh DB T를 읽어 **같은 T로 JWT iat/exp와 idle deadline**을 재검증한다. Row가 없으면 조회 완료 뒤 fresh T로 JWT를 재검증한다. Request/transaction 시작 시각을 재사용하지 않는다.
5. 활성·미만료 session은 last_active_at을 갱신/commit한다. **Session 없음·이미 revoked는 활동 0으로 residual 검색 허용**, 존재하는 미폐기 session의 idle 만료는 활동·예약 없이 401이다. User를 조회하거나 user/session을 upsert하지 않는다.
6. DB 정상 처리/commit 후 기존 quota prune/count/reserve를 upstream 직전 하나의 원자 연산으로 수행하고 같은 실행 구간에서 즉시 adapter를 호출한다. 사이에 새 await·DB 작업·설정 확인을 두지 않는다. Admission 보호가 capacity를 유지하며 최종 monotonic 호출 시각으로 예약한다. 이전 capacity 확인 시각을 예약 시각으로 쓰지 않는다. Adapter 시작 후 admission을 해제하고 외부 응답을 기다린다.
7. Upstream 성공·0건·오류·5초 timeout·호출 후 기능 실패는 예약과 인정한 활성 session 활동을 유지한다. DB commit과 network 호출 사이 process crash를 한 transaction으로 만들 수는 없다. 이때 활동이 남고 예약/호출이 없을 수 있으나 admission을 통과한 기능 처리 실패로 분류한다.

4번 post-lock T에서 JWT·입력·설정·capacity·활동 자격을 통과한 때가 해당 요청의 인증/활동 인정 시점이다. 이후 commit/응답 중 exp·idle 경계를 지나도 인정한 요청을 다시 401로 바꾸지 않는다. Commit 뒤 reservation 전에 인증/입력을 다시 검사해 활동이 남은 최초 인증 거절을 만들지 않는다. T 이후 DB timeout·commit 불명·process 실패는 인정 후 기능 처리 실패이며 활동 commit 여부가 불명일 수 있다. Exp 이후 **신규 admission**은 401이므로 새 요청 자격을 연장하지 않는다.

## DB 장애와 residual JWT

DB read/write/commit 실패·timeout은 `500 INTERNAL_SERVER_ERROR`와 기존 검색 message이며 **upstream 0·quota 예약 0**이다. Commit 불명이면 활동이 commit됐을 수 있지만 rollback을 주장하지 않고 upstream을 시작하지 않는다.

정상 DB에서 revoked/삭제 row가 없는 것은 residual 경로이고 DB 접근 불가는 오류다. JWT verify에 DB가 없다는 사실은 DB에 독립적인 검색 가용성 보장이 아니다. DB 장애에도 residual/일반 검색을 성공시킬 요구가 생기면 best-effort 활동 등의 별도 정책 승인이 필요하다. 삭제/폐기 session의 JWT는 exp까지 검색할 수 있지만 활동으로 session/user를 복원하거나 새 user에 연결하지 않는다.

## 내부 deadline과 resource

내부 직렬화 대기 시작부터 DB lock/write/commit까지 **총 2초 deadline 하나**를 제안한다. 매 단계 새 2초를 시작하지 않는다. 만료는 위 500·미예약이며 기다리는 요청을 즉시 취소·연결 해제한다. 뒤늦은 DB callback이 quota 예약/upstream을 시작하지 못하게 한다. DB cancel/rollback·connection 종료는 별도로 완료하고 commit 불명은 위 contract로 처리한다. 대기 뒤 권한은 fresh post-lock T로 판단한다.

Account entry는 최근 60초 reservation 또는 살아 있는 admission 요청이 있는 동안만 유지한다. Deadline/연결 취소 시 waiter 참조를 제거하고 둘 다 없으면 삭제한다. 대기 중 quota prune이 entry를 교체해 같은 account lock을 둘 만들지 않는다.

2초는 대기 시간 상한이며 동시 유입량·memory의 고정 상한이 아니다. Ingress/pending-request 수 제한은 별도 운영 gate이고 전체 서비스 한도 수치는 미정이다. 내부 admission 대기 허용과 resource/cancel validation을 승인받아야 하며 quota retry queue는 만들지 않는다.

## 계정 API 활동과 기능 단계

`GET /me`, `PATCH /me/nickname`을 계정 기능 활동으로 인정하는 분류를 제안한다. JWT → 입력 → 해당 endpoint에 향후 승인된 제한 → user/session lock → 활성·미만료 확인 → 활동 commit → 기능 처리 순서다. Nickname 횟수/cooldown 제한은 없고 검색 quota를 공유하지 않는다.

최초 admission의 인증/입력 거절은 활동 0이다. 이후 기능 실패에도 인정한 활동을 유지하므로 nickname update 실패와 함께 activity commit을 임의 rollback하지 않는다. 계정 조회/nickname mutation 기능 단계는 다시 user/session 유효성을 잠금 안에서 확인해 logout/삭제 뒤 조회·변경을 막는다.

두 번째 확인에서 경합으로 401이면 **인정 후 기능 단계 거절**이다. 이미 commit한 활동은 유지하고 조회 결과/nickname mutation은 0이다. 삭제의 cascade 결과는 존중한다. 최초 거절의 활동 0과 혼동하지 않는다. JWT는 최초 admission에서 판정하고 기능 단계 시간 경과만으로 인정한 활동을 되돌리지 않는다.

Health/refresh/logout/login 상태 확인은 기존 session 활동이 아니다. 계정/인증 기능의 DB 장애는 auth용 503이며 검색 DB 장애의 500과 구분한다.

## 승인 선택과 검증 경계

권고는 admission+DB commit 뒤 reserve다. 활동 best effort는 장애 중 사용해도 30일 deadline이 연장되지 않는 대안이다. Reserve 뒤 DB 실패에도 예약 유지는 upstream 없는 실패 차감 정책을 추가하고, activity 뒤 quota는 429도 활동으로 만들며, DB quota는 승인된 memory 저장 범위를 바꾼다. 어느 대안도 구현자가 묵시 선택하지 않는다.

관련 validation은 401/400/429 우선순위, 정확한 만료, 11개 동시 요청의 최대 10 upstream, DB 실패/commit 불명·residual row 없음, 최종 예약 시각, 단일 2초와 late completion/취소/entry 수명, 활동 commit 뒤 logout/삭제 경합의 최종 상태를 포함한다. 상세 예상 matrix와 실행 evidence는 Execution Issue/PR에 두고 이 proposal의 검토를 runtime 성공으로 표시하지 않는다.
