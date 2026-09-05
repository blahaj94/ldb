---
type: rule
status: proposed
enforcement: approval-required
scope: apps/api authentication dependencies and database operations
last-reviewed: 2026-09-05
rationale: 인증·DB dependency와 Migration을 승인된 API runtime에 연결하고 미확인 gate를 남긴다.
evidence: "Issue #39 Proposal Revision 2: https://github.com/blahaj94/ldb/issues/39#issuecomment-5551313691"
exceptions: 미승인 후보이며 package 설치·lockfile 변경·DB 실행을 허용하지 않는다.
review-after: 승인 뒤 최초 engine·peer·ESM·DB validation 또는 후보 변경 시
---

# Authentication Runtime Proposal

이 문서 전체는 미승인 proposal이다. [`api-runtime.md`](api-runtime.md)의 승인된 Node 24/Nest 12/ESM/TypeScript 5.9·tsc→Node·내장 test runner 계약을 유지한다. 아래 후보는 승인된 직접 dependency 목록에 포함되지 않는다. [`change-control.md`](change-control.md)의 명시적 승인과 별도 구현 task/gate 확인 전 설치·구현하지 않는다.

## 직접 dependency 승인 요청

**이번 승인 요청의 구체적 대상은 아래 역할과 exact candidate version**이다. 더 넓은 major/minor/patch 허용 범위는 #39에서 정하지 않았으므로 미결정이며 이 PR 승인으로 자동 확대하지 않는다. 실제 구현 시 승인된 범위를 확인하고 해결 version을 lockfile에 고정한다. 후보·역할 변경이나 TypeScript/runtime 변경이 필요하면 다시 승인받는다.

| Runtime 후보 | 역할 | #39의 2026-09-05 metadata evidence와 남은 확인 |
| --- | --- | --- |
| `@nestjs/typeorm 12.0.1` | Nest lifecycle/DI 통합 | ESM, Node >=20.19, peer Nest ^10/11/12, TypeORM ^0.3 또는 ^1.0.0-dev, reflect-metadata ^0.1.13/0.2, rxjs ^7.2. 당시 Nest 12.0.1·Node >=24.15와 metadata상 양립. 실제 해결 peer 조합 확인 필요. |
| `typeorm 1.1.1` | Entity/transaction/Migration | Engine `^20.19.0 \|\| ^22.13.0 \|\| >=24.11.0`, pg peer ^8.5.1. Node floor 충족. 0.3 API/CLI 예를 1.1에 복사하지 않고 release/API·TS5.9 compatibility 검증 필요. |
| `pg 8.23.0` | PostgreSQL driver | Node >=16, TypeORM pg peer 충족. Optional pg-native를 설치하지 않고 직접 pg API import가 없으면 @types/pg를 추가하지 않음. |
| `jose 6.2.12` | JWT/JWS/JWKS 검증·발급 | ESM, 직접 runtime dependency 없음, WebCrypto 지원. Node24 ES256/JWKS cache·TS5.9 실행 검증 필요. Nest JWT/Passport·Google SDK 중복 추가 없음. |

Registry의 고정 version 근거: [@nestjs/typeorm](https://registry.npmjs.org/%40nestjs%2Ftypeorm/12.0.1), [typeorm](https://registry.npmjs.org/typeorm/1.1.1), [pg](https://registry.npmjs.org/pg/8.23.0), [jose](https://registry.npmjs.org/jose/6.2.12). 이 문서는 #39의 dated evidence를 옮겼으며 새 metadata 확인·설치/build/DB 검증을 수행했다는 뜻이 아니다. 구현 시 engine/peer와 실제 compiled ESM compatibility를 검증해야 한다. TypeORM 0.3 또는 Nest 통합 없이 DataSource 주입은 비용을 다시 비교할 대안이며 실패를 피하려 임의 채택하지 않는다.

## PostgreSQL과 Migration

PostgreSQL server major·image digest는 미정이다. 기본 제약·행 잠금·partial index를 지원하는 선택 major를 명시해 후속 Docker integration test에 사용한다. 로컬 DB도 Docker만 허용한다.

- `synchronize:false`, `migrationsRun:false`로 앱 시작이 schema를 자동 변경하지 않는다.
- TypeORM compiled JavaScript DataSource/Migration CLI로 승인된 tsc→Node ESM 실행을 유지한다. ts-node/Nest CLI나 새 runner를 추가하지 않는다.
- 최초 Migration은 [`auth-database.md`](auth-database.md)의 4개 테이블·named FK/CHECK/index를 만든다. 새 DB apply, 재실행 no-op, 직접 constraint 위반 거절, Migration 목록/schema를 후속 검증한다.
- 배포 담당의 단일 명시 실행으로 transaction 적용하며 동시 자동 실행을 금지한다. 운영 destructive down을 자동 실행하지 않는다. Rollback 검증은 빈 disposable test DB에 한정한다.
- 운영 변경은 검토한 forward migration/백업 절차의 별도 승인을 따른다. DB credential·key/provider 필수 설정은 해당 module을 연결할 때부터 listen 전에 값/stack 없이 정제 검증한다. 미연결 runtime-only app에 이 설정을 요구하지 않는다.

Migration의 문서 근거는 #39가 읽은 [TypeORM Migration setup](https://typeorm.io/docs/migrations/setup/)이며 선택 version의 실제 CLI·ESM 검증이 남아 있다. 이 proposal에서 Migration file/command/package script를 추가하거나 실행하지 않는다.

## 승인과 미결정 gate

이번 Rule 승인 대상은 API/security/schema/보관·key 주기·활동 분류·admission/DB 장애·body/deadline 정책과 위 exact dependency 후보다. 승인을 받더라도 다음 미정이 필요한 구현은 별도 결정/검증을 완료해야 한다.

- PostgreSQL major/image digest, 운영 deployment topology와 single process 조건, clock 동기화·역행 감지, 실제 cleanup 시각·key 운영 절차
- 더 넓은 dependency 허용 범위, 후보의 compiled ESM/TypeScript/runtime compatibility
- 실제 client/HTTPS callback/protocol 등록값·provider config snapshot, Electron OS 저장/IPC 및 실제 browser/OS 연동
- Discord 일반 confidential OAuth PKCE의 공식 적용 근거와 후속 wrong/missing verifier·downgrade 거절 E2E
- 공개 ingress/pending-request·인증 전 abuse·서비스 전체 limiter 수치와 기존 quota와의 통합 순서
- 탈퇴 별도 state·삭제와 pending login/재가입 경합·provider revoke 복구·백업 복원 후 삭제 회원 방지

마지막 탈퇴 gate는 로그인 핵심 설계 완료를 막지 않지만 탈퇴 구현 authority를 만들지 않는다. Rule-only PR에서 멈춘다는 작업 경계는 `change-control.md`의 승인 뒤 같은 PR Red/Green 일반 순서를 자동 착수 지시로 해석하지 못하게 한다. 후속 구현은 별도 task 범위와 승인 evidence를 확인해 Red→Green과 관련 validation을 수행한다.
