---
type: rule
status: proposed
enforcement: approval-required
scope: apps/api core authentication database
last-reviewed: 2026-09-05
rationale: identity uniqueness·단일 소비·경합·보관 정책을 DB invariant와 연결한다.
evidence: "Issue #39 Proposal Revision 2: https://github.com/blahaj94/ldb/issues/39#issuecomment-5551313691"
exceptions: 미승인 schema proposal이며 탈퇴 state·삭제/재가입·백업 복원은 이 schema로 해결하지 않는다.
review-after: 최초 Docker constraint·migration·cleanup 경합 validation 시
---

# Authentication Database Proposal

이 문서 전체는 신규 승인 대상 proposal이다. OAuth 상태는 [`auth-oauth.md`](auth-oauth.md), 시간/refresh는 [`auth-session.md`](auth-session.md), 활동은 [`auth-activity.md`](auth-activity.md), dependency/Migration 실행은 [`auth-runtime.md`](auth-runtime.md)를 따른다. 기본 영구 3개 테이블에 회원 생성 전 로그인용 transient table 하나를 추가하는 안이다.

## 공통 schema 규격

UUID는 API의 CSPRNG 기반 UUID로 생성하고 새 PostgreSQL extension을 요구하지 않는다. 시간은 서버 UTC whole-second `timestamptz`다. 원문 token은 어느 테이블에도 저장하지 않는다. 아래 permanent table은 nullable 표시 외에는 NOT NULL이다. **Transient table의 proof/secret/subject는 상태별로 nullable이며 terminal 정리 규칙이 우선**한다.

| Table | Field와 제약 |
| --- | --- |
| `users` | `id uuid PK`, `provider text CHECK IN ('google','discord')`, nonempty `provider_subject text COLLATE "C"`, nonempty `nickname text`, `created_at`. `UNIQUE(provider,provider_subject)`. Nickname unique 없음. Subject는 opaque case-sensitive string이며 숫자로 변환하지 않음. |
| `auth_sessions` | `id uuid PK`, `user_id uuid FK users ON DELETE CASCADE`, `created_at`, `last_active_at`, nullable `revoked_at`, nullable `revoked_reason`(logout/refresh_reuse만). `last_active_at>=created_at`, revoked pair null 여부 일치, `revoked_at>=created_at`. user_id/정리 조회용 last_active_at index. Absolute expiry·하드웨어 ID·fingerprint·provider token 없음. |
| `auth_refresh_tokens` | `token_hash bytea PK CHECK octet_length=32`, `session_id uuid FK auth_sessions ON DELETE CASCADE`, `issued_at`, nullable `consumed_at`이며 `consumed_at>=issued_at`. `UNIQUE(session_id) WHERE consumed_at IS NULL` partial unique index로 미소비 최대 하나. 이력/정리용 session_id index. |

현재 시각에 따라 변하는 idle 만료를 CHECK/partial index에 넣지 않는다. Nickname 20 grapheme을 varchar(20)/char_length로 대체하지 않고 [`auth-api.md`](auth-api.md)의 API validator가 담당한다. Nonempty DB 제약과 transport byte cap은 별개다.

## `auth_login_requests`

이 row는 회원보다 먼저 존재하므로 단순 users FK에 종속시키지 않는다. Identity는 users가 영구 저장하고 transient verified subject는 앱 exchange 자격에만 쓴다.

| Field group | 제약/nullable 의미 |
| --- | --- |
| Request와 등록 | `id uuid PK`, `purpose='login'`, google/discord provider, `client_id='desktop'`, `provider_config_version`, `return_target_id`(등록 snapshot/version), `created_at`, `expires_at`, `status`는 요청 식별/상태 값. `expires_at>created_at`. |
| 앱 proof | `code_challenge`, `method='S256'`는 진행 중 필수. Terminal에서는 proof 정리를 위해 nullable로 취급하며 NOT NULL blanket을 적용하지 않음. |
| Browser/provider proof | Nullable `launch_ticket_hash bytea UNIQUE`, `state_hash bytea UNIQUE`, `browser_binding_hash bytea`, `oidc_nonce_hash bytea`; 존재하는 hash는 32byte. Nullable `provider_pkce_ciphertext/iv/tag/key_id`. |
| 완료/소비 | Nullable `verified_subject text`, `exchange_code_hash bytea UNIQUE`, `code_expires_at`, `consumed_at`; code hash는 32byte, `code_expires_at<=expires_at`. |

Status는 created/browser_started/processing/exchange_ready/consumed/failed다. 상태별 CHECK와 conditional UPDATE/row lock을 함께 사용한다. CHECK만으로 single-use를 해결했다고 간주하지 않는다.

| 상태 | 필수/허용 상태 invariant |
| --- | --- |
| `created` | Launch hash와 앱 proof·등록 snapshot이 필요. 아직 browser/provider claim·검증 subject·exchange code 없음. |
| `browser_started` | Ticket 소비 완료, browser binding·state·provider proof 필요. Google nonce는 Google 검증에 필요. |
| `processing` | Claim한 callback 연결 정보로 provider 교환 한 번만 허용. 외부 HTTP 동안 row lock 미유지. |
| `exchange_ready` | 검증 subject+code hash+deadline과 앱 교환 proof 필요. Code deadline은 전체 request TTL을 넘지 않음. |
| `consumed`, `failed` | 해당 소비/실패 상태와 최소 시간만 남기고 secret/proof/subject field를 terminal commit에서 null 처리. Consumed 시각은 소비 완료를 나타냄. |

원문 설계가 exact SQL CHECK의 모든 field 조합을 열거하지는 않았다. 위 필수/비허용 및 terminal null 의미를 구현에서 보존해야 하며, 추가 보관 field·상태·CHECK 정책을 선택할 필요가 생기면 schema 승인 범위를 재확인한다. 명세의 nullable을 terminal credential 보관 허가로 읽지 않는다.

## Provider PKCE 암호화

매 요청 별도 32 random byte verifier를 S256으로 사용하고 AES-256-GCM으로 transient row에 저장한다. 매 암호화 독립 96-bit IV, request ID/provider/purpose AAD, 128-bit tag를 사용한다. 암호화 key는 DB 밖 secret으로 JWT key와 분리한다.

Key 교체 시 이전 pending request 최대 10분이 끝날 때까지 decrypt key를 유지하거나 해당 request를 명시적으로 실패 처리한다. 복호화 실패는 로그인 실패이며 plaintext를 로그/저장해 복구하지 않는다. 추가 secret/field가 승인 대상이다. Memory-only proof는 재시작 시 request 무효화를 수용하는 대안으로 별도 결정 없이 바꾸지 않는다.

## Transaction과 잠금 순서

하나의 TypeORM QueryRunner/transaction manager와 연결만 사용하고 transaction manager 밖 repository를 섞지 않는다. 일반 순서는 **필요한 user → session → refresh**이며 여러 row는 UUID 오름차순이다. Exchange는 자신의 OAuth row를 먼저 잠그고 user→새 session→refresh로 간다. 다른 session 작업이 OAuth row를 뒤에 잠그지 않는다. 검색 활동은 session만 잠그고 뒤에 user/refresh를 잠그지 않아 역순 cycle을 만들지 않는다.

Raw token hash의 잠금 없는 조회는 ID hint다. Lock 뒤 FK·소유관계·hash 존재·상태를 다시 확인한다. 시간은 lock 뒤 fresh T이며 거래 시작 시각을 재사용하지 않는다.

동일 provider/subject의 동시 가입은 exchange row lock 후 `INSERT users ... ON CONFLICT(provider,provider_subject) DO NOTHING RETURNING id`로 처리한다. Insert winner만 랜덤 nickname과 isNewUser=true를 확정한다. Loser는 READ COMMITTED의 **다음 statement**에서 기존 user를 잠가 읽고 nickname을 바꾸지 않는다. 하나의 CTE snapshot에서 loser row가 항상 보인다고 가정하지 않는다. 두 exchange는 같은 user·서로 다른 session/refresh로 완료한다. Conflict 대기 뒤 user가 없으면 rollback+503으로 재시작을 안내하고 삭제한 user ID를 복원하지 않는다.

## 종료 session과 OAuth 정리

- Refresh 가능한 활성 session의 모든 발급·소비 hash를 유지한다. 최근 N개, issued_at+30일, rotation 즉시 old row 삭제는 금지한다. 오래 활성인 session의 이력은 계속 늘며 이를 줄이려 absolute lifetime을 추가하지 않는다.
- Revoked_at 이후 또는 정확한 idle deadline 이후 session은 **별도 보관 유예 없이 다음 cleanup에서 session+refresh 전체 삭제**를 제안한다. 이후 old token은 unknown이며 대상 session이 없으므로 재발급하지 않는다. 늦은 유효 JWT는 residual 검색, 새 session은 다른 UUID다. 조사용 추가 보관은 목적/기한 별도 승인 대상이다.
- Cleanup은 dependency 없는 기존 실행 기반 command로 시작 시 1회+운영 하루 1회를 제안한다. 주기/실제 시각은 운영 승인 대상이다. 실패하면 삭제가 지연되지만 매 요청 TTL/idle/revoked 거절은 유지한다. 24시간 내 삭제를 보장하지 않는다.
- Cleanup도 session lock 뒤 fresh T로 종료 조건을 재확인한다. 활동이 먼저 deadline 연장을 commit했으면 보존하고 cleanup이 만료를 먼저 판정하면 대기한 활동/refresh가 부활시키지 못한다. Batch SKIP LOCKED는 구현 선택일 수 있으나 종료 재판정을 생략하지 않는다.
- OAuth 성공/실패 terminal commit 때 secret/proof/subject를 즉시 null 처리한다. 만료 request를 읽으면 가능한 transaction에서 민감 field도 정리하고 terminal/만료/중단 row는 다음 성공 cleanup에서 삭제한다.
- **교환 자격 TTL은 물리 보관 상한이 아니다.** Exchange_ready subject/code proof는 소비 또는 TTL까지만 기능상 필요하지만 만료/crash/DB 장애 뒤 실제 subject/암호화 PKCE가 남을 수 있다. 시작+하루 1회 권고는 10분 또는 24시간 내 물리 삭제 보장이 아니며 cleanup 실패는 더 지연시킨다. 이 보관 잔여/지연을 승인받아야 한다. 더 짧은 물리 상한은 별도 reliable cleanup·운영 설계가 필요하다. 지연이 만료 후 exchange 자격을 늘리지는 않는다.

## 삭제 경계

User 삭제 시 sessions→refresh cascade는 기본 구조다. JWT sub/sid로 삭제 계정/session을 재생성하거나 다른 새 user에 연결하지 않는다. **User 삭제 후에도 남을 탈퇴 결과 state, pending login과 삭제의 자동 재가입 경합, 백업 복원 후 삭제 회원 방지**는 이 cascade로 해결되지 않는다. 별도 정책/schema 승인 전 탈퇴 endpoint를 구현하지 않으며 tombstone·복구 유예·장기 provider 식별 보관을 임의 추가하지 않는다.

근거는 #39가 2026-09-05에 검토한 [constraints](https://www.postgresql.org/docs/current/ddl-constraints.html), [partial index](https://www.postgresql.org/docs/current/indexes-partial.html), [INSERT/ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html), [row lock/deadlock](https://www.postgresql.org/docs/current/explicit-locking.html)다. Schema/DB 실행 성공 evidence가 아니다.
