---
type: rule
status: active
enforcement: approval-required
scope: apps/api authentication dependencies and database operations
last-reviewed: 2026-09-05
rationale: 인증·DB dependency와 Migration을 승인된 API runtime에 연결하고 미확인 gate를 남긴다.
evidence: "PR #48 사용자 승인: https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519 ; 설계 근거: Issue #39 Proposal Revision 2 https://github.com/blahaj94/ldb/issues/39#issuecomment-5551313691"
exceptions: Exact dependency 역할·version 승인과 별개로 사용자 지시에 따라 설치·lockfile 변경·DB 실행을 허용하지 않는다.
review-after: 최초 engine·peer·ESM·DB validation 또는 승인된 version 변경 시
---

# Authentication Runtime Contract

이 문서는 [PR #48의 사용자 승인](https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519)을 반영한 Rule이다. [`api-runtime.md`](api-runtime.md)의 승인된 Node 24/Nest 12/ESM/TypeScript 5.9·tsc→Node·내장 test runner 계약을 유지하며 아래 exact dependency 역할·version을 승인 목록에 추가한다. 현재 설치·구현·검증 성공을 뜻하지 않는다. 사용자의 미결정 gate 유지와 구현 금지 조건에 따라 후속 착수 지시 전에는 설치·구현하지 않으며 [`change-control.md`](change-control.md)를 따른다.

## 승인된 직접 dependency

**승인 범위는 아래 역할과 exact version**이다. 더 넓은 major/minor/patch 허용 범위는 #39에서 정하지 않았으므로 미결정이며 이번 승인으로 자동 확대하지 않는다. 실제 구현 시 승인된 범위를 확인하고 해결 version을 lockfile에 고정한다. Version·역할 변경이나 TypeScript/runtime 변경이 필요하면 다시 승인받는다.

| Runtime / 승인된 exact version | 역할 | #39의 2026-09-05 metadata evidence와 남은 확인 |
| --- | --- | --- |
| `@nestjs/typeorm 12.0.1` | Nest lifecycle/DI 통합 | ESM, Node >=20.19, peer Nest ^10/11/12, TypeORM ^0.3 또는 ^1.0.0-dev, reflect-metadata ^0.1.13/0.2, rxjs ^7.2. 당시 Nest 12.0.1·Node >=24.15와 metadata상 양립. 실제 해결 peer 조합 확인 필요. |
| `typeorm 1.1.1` | Entity/transaction/Migration | Engine `^20.19.0 \|\| ^22.13.0 \|\| >=24.11.0`, pg peer ^8.5.1. Node floor 충족. 0.3 API/CLI 예를 1.1에 복사하지 않고 release/API·TS5.9 compatibility 검증 필요. |
| `pg 8.23.0` | PostgreSQL driver | Node >=16, TypeORM pg peer 충족. Optional pg-native를 설치하지 않고 직접 pg API import가 없으면 @types/pg를 추가하지 않음. |
| `jose 6.2.12` | JWT/JWS/JWKS 검증·발급 | ESM, 직접 runtime dependency 없음, WebCrypto 지원. Node24 ES256/JWKS cache·TS5.9 실행 검증 필요. Nest JWT/Passport·Google SDK 중복 추가 없음. |

Registry의 고정 version 근거: [@nestjs/typeorm](https://registry.npmjs.org/%40nestjs%2Ftypeorm/12.0.1), [typeorm](https://registry.npmjs.org/typeorm/1.1.1), [pg](https://registry.npmjs.org/pg/8.23.0), [jose](https://registry.npmjs.org/jose/6.2.12). 이 문서는 #39의 dated evidence를 옮겼으며 새 metadata 확인·설치/build/DB 검증을 수행했다는 뜻이 아니다. 구현 시 engine/peer와 실제 compiled ESM compatibility를 검증해야 한다. TypeORM 0.3 또는 Nest 통합 없이 DataSource 주입은 비용을 다시 비교할 대안이며 실패를 피하려 임의 채택하지 않는다.

## PostgreSQL 선택과 Docker 검증 proposal — 승인 대기

> 이 구간은 Issue #49의 **승인 대기 proposal**이다. Draft PR의 명시적인 사용자 승인 전에는 active Rule이나 image pull·DB 실행·구현 authority가 아니다. 기존 승인 metadata와 아래 Migration 계약은 그대로 유지한다.

### 선택과 근거

2026-09-05 확인 기준 PostgreSQL 18의 current minor는 18.6이고 2030-11-14까지 지원된다. PostgreSQL은 지원 major의 current minor 사용을 권고한다. 기존 schema가 쓰는 constraint, `COLLATE "C"`, partial unique index, `INSERT ... ON CONFLICT`, row lock은 PostgreSQL 18 공식 문서에 있는 기능이다. 따라서 server major 18과 아래 Docker Official Image를 후속 local integration 기준으로 제안한다. 이 문서 검토는 `pg 8.23.0`·`typeorm 1.1.1`의 실제 ESM 연결 성공 evidence가 아니며 그 확인은 아래 실행 matrix에 남긴다.

- Image reference: `docker.io/library/postgres:18.6-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af`
- 위 digest는 tag가 가리키는 `application/vnd.oci.image.index.v1+json` **manifest index digest**다. 실행 platform image manifest digest와 혼동하지 않는다.
- Official tag는 `amd64`, `arm32v7`, `arm64v8`, `i386`, `ppc64le`를 제공하지만 이 integration contract의 target은 native `linux/amd64`와 native `linux/arm64/v8`만이다. Index가 가리키는 image manifest는 각각 `sha256:a10c981235b4f635e65df0cfb66a5598064628128505dbc6a3ed4ca303717521`, `sha256:4d155aa3f2c2cc1838bb70e81396f76373ec7275ec9ce9cf32873cd677c9a992`다. 한 platform의 성공은 그 platform만 증명하며 둘 모두의 검증 성공이나 운영 architecture 확정을 뜻하지 않는다.
- Tag만 고정하면 base image rebuild 때 같은 tag가 다른 content를 가리킬 수 있으므로 index digest도 함께 고정한다. 실행 시 target platform을 명시하고 실제 선택된 child digest가 위 값인지 기록한다. Index의 `unknown/unknown` provenance descriptor는 실행 platform으로 세지 않는다.

근거는 [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/), [PostgreSQL 18 constraint](https://www.postgresql.org/docs/18/ddl-constraints.html)·[partial index](https://www.postgresql.org/docs/18/indexes-partial.html)·[`INSERT`](https://www.postgresql.org/docs/18/sql-insert.html)·[locking](https://www.postgresql.org/docs/18/explicit-locking.html), [Docker Official Image 목록](https://github.com/docker-library/official-images/blob/b6c89f1d7f2351bbeb960a5ba0bd6d7d5a11e5bb/library/postgres), [18.6-bookworm Dockerfile](https://github.com/docker-library/postgres/blob/e00e1bd34ec5c8a8e7ad89b273b3d42efaf6d5bc/18/bookworm/Dockerfile), [Docker Hub tag metadata](https://hub.docker.com/v2/repositories/library/postgres/tags/18.6-bookworm), [OCI image index](https://github.com/opencontainers/image-spec/blob/v1.1.1/image-index.md)다. Registry V2 response body의 SHA-256과 `Docker-Content-Digest`, Docker Hub index/child metadata를 2026-09-05에 대조했으며 image는 pull하지 않았다.

PostgreSQL 19는 확인 시점 Beta 3이므로 선택하지 않는다. 대안인 `17.11-bookworm`은 지원 중이지만 종료일이 2029-11-08이고 17 이하의 image data mount는 `/var/lib/postgresql/data`라서 더 이른 major upgrade와 다른 volume 경계를 수용해야 한다. `18.6-trixie`는 더 많은 architecture를 제공하지만 현재 target 밖이며 base variant 범위를 넓힌다. `18.6-alpine3.24`는 image 크기를 줄일 수 있지만 musl 기반 차이를 추가한다. 현재 범위는 Debian bookworm variant가 제공하는 두 target만 필요하므로 이 대안들을 채택하지 않는다.

PostgreSQL 18 image의 `PGDATA`는 `/var/lib/postgresql/18/docker`, declared `VOLUME`은 `/var/lib/postgresql`이다. Disposable named volume은 parent 경로 `/var/lib/postgresql`에 mount하고 `PGDATA`를 위 version-specific 경로로 명시한다. 이 경계는 local test data를 run마다 버리기 위한 것이며 운영 volume topology, backup, restore, major upgrade 정책을 정하지 않는다. [Official Image 문서](https://hub.docker.com/_/postgres)는 Docker용 환경변수와 `/docker-entrypoint-initdb.d`가 empty data directory에서만 작동하고 init script용 임시 daemon은 Unix socket만 listen한다고 설명한다.

### Docker-only disposable integration contract

1. PostgreSQL server는 Docker container에서만 실행한다. Run마다 충돌하지 않는 container와 Docker-managed named volume, 필요하면 network를 새로 만들고 재사용하지 않는다. Host bind는 `127.0.0.1`의 동적 port만 허용한다. Test credential은 run 중 생성해 repository나 log에 남기지 않는다.
2. 위 tag+index digest와 native target platform을 함께 지정하고 named volume을 `/var/lib/postgresql`에 mount한다. App schema용 init script를 `/docker-entrypoint-initdb.d`에 넣지 않는다. Image entrypoint는 empty `PGDATA`에 PostgreSQL cluster와 test DB를 초기화할 뿐이며 4개 auth domain table은 readiness 뒤 compiled JavaScript Migration의 단일 명시 실행만 만든다.
3. Readiness는 Migration이 쓸 것과 같은 host TCP 경로·database·user·password로 인증하고 bounded retry 안에서 `SELECT 1`이 성공해야 충족된다. Container running/health 상태나 `pg_isready`만으로 migration-ready를 주장하지 않는다. 이어서 server가 18.6이고 실제 child manifest digest가 선택 platform의 고정값인지 evidence에 남긴다.
4. 실패, 성공, timeout, signal 모두 `finally` 성격의 teardown을 수행한다. 이번 run이 만든 exact container, named volume, network만 ID로 삭제하고 부재를 확인한다. Global prune, 이름 pattern에 의한 광역 삭제, 기존·운영 resource 삭제를 금지한다. Disposable volume 삭제는 test fixture teardown이며 [`auth-database.md`](auth-database.md)의 revoked/idle session과 OAuth row cleanup·보관 정책을 실행하거나 바꾸는 것이 아니다.

후속 Worker는 target platform마다 다음 결과를 실제 실행 evidence와 구분해 기록한다. 한 native platform만 실행했다면 다른 platform은 미검증으로 남긴다.

| 검증 | 실행과 통과 기준 |
| --- | --- |
| Fresh apply | App relation이 없는 새 test DB에서 compiled ESM DataSource/Migration을 한 번 명시 실행한다. `auth-database.md`의 auth domain table은 정확히 4개다. 별도의 TypeORM Migration history metadata는 실행 기반 내부 table로 구분하며 새 auth domain table 승인으로 세지 않는다. |
| Re-run no-op | 같은 Migration을 다시 실행해 pending Migration과 schema 변경이 없음을 확인한다. |
| Migration 목록·schema | Applied Migration 목록과 catalog를 조회해 column/nullability/collation, named unique·FK·CHECK, 일반 index와 partial unique index가 승인 contract와 일치하고 예상 밖 auth relation이 없음을 확인한다. |
| 위반 거절 | 각각 격리한 transaction에서 duplicate provider identity·미소비 refresh, orphan FK, nonempty/시간/revoked pair/hash/status별 CHECK, partial unique 위반이 해당 constraint/index에서 거절되고 rollback 뒤 fixture가 오염되지 않음을 확인한다. |
| 자동 schema 변경 없음 | `synchronize:false`, `migrationsRun:false`로 app을 시작·종료한 전후 catalog가 동일해야 한다. App 시작이 fresh DB에 auth table이나 Migration history를 만들지 않고 migrated DB도 바꾸지 않는다. |
| Disposable rollback | Migration down은 별도의 빈 disposable test DB에서만 실행한다. Auth domain table 제거와 Migration history의 일관성을 확인하고 운영 destructive down의 근거로 사용하지 않는다. |

`auth-database.md`의 transaction manager, user→session→refresh 및 OAuth 선행 잠금 순서, lock 뒤 fresh time 재확인, cleanup/terminal null·삭제 의미는 그대로다. 위 matrix가 그 runtime 경합을 이미 검증했다고 표시하지 않으며 관련 flow 구현 때 별도 Docker integration evidence가 필요하다.

### 갱신 gate

PostgreSQL current minor/security release, major 지원 상태, official tag의 index 또는 target child digest, base variant, target platform, `PGDATA`/`VOLUME` 의미가 바뀌거나 실제 ESM/DB matrix가 실패하면 선택을 재검토한다. Tag/digest/version 교체는 새 dated metadata와 전체 matrix 계획을 포함한 Rule proposal로 다시 승인받는다. 고정 digest가 재현하는 오래된 bytes를 보안 update 대신 계속 사용하지 않는다.

## 승인된 Migration 계약

- `synchronize:false`, `migrationsRun:false`로 앱 시작이 schema를 자동 변경하지 않는다.
- TypeORM compiled JavaScript DataSource/Migration CLI로 승인된 tsc→Node ESM 실행을 유지한다. ts-node/Nest CLI나 새 runner를 추가하지 않는다.
- 최초 Migration은 [`auth-database.md`](auth-database.md)의 4개 테이블·named FK/CHECK/index를 만든다. 새 DB apply, 재실행 no-op, 직접 constraint 위반 거절, Migration 목록/schema를 후속 검증한다.
- 배포 담당의 단일 명시 실행으로 transaction 적용하며 동시 자동 실행을 금지한다. 운영 destructive down을 자동 실행하지 않는다. Rollback 검증은 빈 disposable test DB에 한정한다.
- 운영 변경은 검토한 forward migration/백업 절차의 별도 승인을 따른다. DB credential·key/provider 필수 설정은 해당 module을 연결할 때부터 listen 전에 값/stack 없이 정제 검증한다. 미연결 runtime-only app에 이 설정을 요구하지 않는다.

Migration의 문서 근거는 #39가 읽은 [TypeORM Migration setup](https://typeorm.io/docs/migrations/setup/)이며 선택 version의 실제 CLI·ESM 검증이 남아 있다. 이번 사용자 지시에 따라 Migration file/command/package script를 추가하거나 실행하지 않는다. 위 proposal이 승인되더라도 별도 구현 착수 지시를 뜻하지 않는다.

## 승인과 미결정 gate

API/security/schema/보관·key 주기·활동 분류·admission/DB 장애·body/deadline 정책과 위 exact dependency 역할·version은 승인됐다. 다음 미정이 필요한 구현은 별도 결정/검증을 완료해야 하며 이번 승인으로 해결된 것으로 간주하지 않는다.

- PostgreSQL major/image digest, 운영 deployment topology와 single process 조건, clock 동기화·역행 감지, 실제 cleanup 시각·key 운영 절차
- 더 넓은 dependency 허용 범위, 승인된 version의 compiled ESM/TypeScript/runtime compatibility
- 실제 client/HTTPS callback/protocol 등록값·provider config snapshot, Electron OS 저장/IPC 및 실제 browser/OS 연동
- Discord 일반 confidential OAuth PKCE의 공식 적용 근거와 후속 wrong/missing verifier·downgrade 거절 E2E
- 공개 ingress/pending-request·인증 전 abuse·서비스 전체 limiter 수치와 기존 quota와의 통합 순서
- 탈퇴 별도 state·삭제와 pending login/재가입 경합·provider revoke 복구·백업 복원 후 삭제 회원 방지

마지막 탈퇴 gate는 로그인 핵심 설계 완료를 막지 않지만 탈퇴 구현 authority를 만들지 않는다. 사용자가 Rule 승인과 함께 구현 금지를 명시했으므로 `change-control.md`의 승인 뒤 같은 PR Red/Green 일반 순서를 자동 착수 지시로 해석하지 않는다. 후속 구현은 별도 착수 지시·task 범위와 승인 evidence를 확인해 Red→Green과 관련 validation을 수행한다.
