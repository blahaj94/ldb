---
type: rule
status: active
enforcement: approval-required
scope: apps/api authentication dependencies and database operations
last-reviewed: 2026-09-10
rationale: 인증의 runtime 호환성, Migration과 DB 실행 조건을 정의한다.
evidence: "PR #48 사용자 승인: https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519 ; 설계 근거: Issue #39 Proposal Revision 2 https://github.com/blahaj94/ldb/issues/39#issuecomment-5551313691"
exceptions: 문서 변경은 dependency 설치, lockfile 변경이나 DB 실행의 착수 허용이 아니다.
review-after: runtime 호환성 또는 DB 실행 조건 변경 시
---

# Authentication Runtime Contract

이 문서는 [PR #48의 사용자 승인](https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519)을 반영한 인증 runtime과 DB 실행 계약입니다. [`api-runtime.md`](api-runtime.md)의 Node 24/Nest 12/ESM/TypeScript 5.9 및 tsc→Node 검증 계약을 유지합니다. 정책 승인과 실제 구현, 호환성 검증 및 운영 실행은 구분하며, 후속 작업은 [`change-control.md`](change-control.md)의 사용자 실행 허용 범위를 따릅니다.

## 의존성 기록과 호환성

패키지 목록, 버전과 변경 절차는 [`API runtime의 의존성 관리`](api-runtime.md#의존성-관리)를 따릅니다. 인증 전용의 패키지 허용 목록이나 exact version별 재승인 조건은 두지 않습니다. 이 변경은 [Issue #302](https://github.com/blahaj94/ldb/issues/302)의 사용자 요청을 반영하며, 해당 문서 변경을 포함한 PR의 사용자 merge로 적용합니다.

기존 패키지 선택의 승인 이력은 [PR #48](https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519)과 [`@types/pg` 선택 PR #118](https://github.com/blahaj94/ldb/pull/118#issuecomment-5570381432)에 보존합니다. 실제 변경에서는 engine과 peer 조건, compiled ESM 및 TypeScript 호환성과 영향받는 인증·DB 동작을 검증합니다. 패키지 선택만으로 검증 성공을 주장하지 않습니다.

로컬 DB는 기존 Docker-only 조건을 유지합니다. PostgreSQL server, image와 local validation의 선택 및 승인 상태는 아래 구간을 따릅니다.

## PostgreSQL 선택과 Docker 검증

| 상태 항목 | 현재 값 |
| --- | --- |
| 선택 상태 | **승인됨** |
| 선택 승인 evidence | [PR #50 사용자 승인](https://github.com/blahaj94/ldb/pull/50#issuecomment-5552245712) (2026-09-05T13:48:26Z) |

이 표가 선택 상태와 evidence의 단일 기준이다. 선택 상태가 merge 대기이면 아래 값은 proposal이며 active Rule이 아니다. 해당 선택과 상태 전환을 채택 범위로 명시한 PR의 사용자 merge를 확인하고 evidence를 기록해 선택 상태를 승인됨으로 바꾼 revision부터 선택 gate만 해소된다. 절차 문구나 link만 수정하면 선택 상태를 바꾸지 않는다. 선택 승인은 image pull·DB 실행·구현 authority나 실제 compatibility·운영 검증 완료를 뜻하지 않으며 기존 승인 metadata와 아래 Migration 계약은 그대로 유지한다.

### 선택과 근거

2026-09-05 확인 기준 PostgreSQL 18의 current minor는 18.6이고 2030-11-14까지 지원된다. PostgreSQL은 지원 major의 current minor 사용을 권고한다. 기존 schema가 쓰는 constraint, `COLLATE "C"`, partial unique index, `INSERT ... ON CONFLICT`, row lock은 PostgreSQL 18 공식 문서에 있는 기능이다. 따라서 server major 18과 아래 Docker Official Image를 후속 local integration 기준으로 제안한다. 이 문서 검토는 `pg 8.23.0`·`typeorm 1.1.1`의 실제 ESM 연결 성공 evidence가 아니며 그 확인은 아래 실행 matrix에 남긴다.

- Image reference: `docker.io/library/postgres:18.6-trixie@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280`
- 위 digest는 tag가 가리키는 `application/vnd.oci.image.index.v1+json` **manifest index digest**다. 실행 platform image manifest digest와 혼동하지 않는다.
- Official tag는 여러 architecture를 제공하지만 이 integration contract의 target은 native `linux/amd64`와 native `linux/arm64/v8`만이다. Index가 가리키는 image manifest는 각각 `sha256:7341002d2b8c7c5bdd7542a671a95b36196c0b5b888daf454ae4fc33ba5346d7`, `sha256:6fd9e18b6fedda0a34e4d53ad6fdbd4289a217300af573c31ec7084e6d9cf329`다. 한 platform의 성공은 그 platform만 증명하며 둘 모두의 검증 성공이나 운영 architecture 확정을 뜻하지 않는다.
- Tag만 고정하면 base image rebuild 때 같은 tag가 다른 content를 가리킬 수 있으므로 index digest도 함께 고정한다. 실행 시 target platform을 명시하고 실제 선택된 child digest가 위 값인지 기록한다. Index의 `unknown/unknown` provenance descriptor는 실행 platform으로 세지 않는다.

근거는 [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/), [PostgreSQL 18 constraint](https://www.postgresql.org/docs/18/ddl-constraints.html)·[partial index](https://www.postgresql.org/docs/18/indexes-partial.html)·[`INSERT`](https://www.postgresql.org/docs/18/sql-insert.html)·[locking](https://www.postgresql.org/docs/18/explicit-locking.html), [Docker Official Image 목록](https://github.com/docker-library/official-images/blob/b6c89f1d7f2351bbeb960a5ba0bd6d7d5a11e5bb/library/postgres), [18.6-trixie Dockerfile](https://github.com/docker-library/postgres/blob/e00e1bd34ec5c8a8e7ad89b273b3d42efaf6d5bc/18/trixie/Dockerfile), [Docker Hub tag metadata](https://hub.docker.com/v2/repositories/library/postgres/tags/18.6-trixie), [OCI image index](https://github.com/opencontainers/image-spec/blob/v1.1.1/image-index.md), [Debian bookworm](https://www.debian.org/releases/bookworm/)·[trixie lifecycle](https://www.debian.org/releases/trixie/)다. Registry V2 response body의 SHA-256과 `Docker-Content-Digest`, Docker Hub index/child metadata를 2026-09-05에 대조했으며 image는 pull하지 않았다.

PostgreSQL 19는 확인 시점 Beta 3이므로 선택하지 않는다. PostgreSQL과 base OS의 지원 기간은 별개다. Debian 13 trixie는 2028-08-09까지 full support, 2030-06-30까지 LTS인 반면 Debian 12 bookworm은 이미 LTS 단계이고 2028-06-30에 종료된다. 기존 distro 제약이 없는 새 integration image이므로 더 긴 base 지원 기간을 가진 trixie를 선택한다. 다만 trixie LTS도 PostgreSQL 18 지원 종료일 2030-11-14보다 먼저 끝나므로 그 전에 variant를 재검토해야 한다. 대안인 `17.11-bookworm`은 PostgreSQL 지원도 2029-11-08에 끝나고 17 이하 image data mount는 `/var/lib/postgresql/data`라서 더 이른 major upgrade와 다른 volume 경계를 수용해야 한다. `18.6-bookworm`은 같은 server version이지만 base 지원 기간이 짧고, `18.6-alpine3.24`는 image 크기를 줄일 수 있지만 musl 기반 차이를 추가한다.

PostgreSQL 18 image의 `PGDATA`는 `/var/lib/postgresql/18/docker`, declared `VOLUME`은 `/var/lib/postgresql`이다. Disposable named volume은 parent 경로 `/var/lib/postgresql`에 mount하고 `PGDATA`를 위 version-specific 경로로 명시한다. 이 경계는 local test data를 run마다 버리기 위한 것이며 운영 volume topology, backup, restore, major upgrade 정책을 정하지 않는다. [Official Image 문서](https://hub.docker.com/_/postgres)는 Docker용 환경변수와 `/docker-entrypoint-initdb.d`가 empty data directory에서만 작동하고 init script용 임시 daemon은 Unix socket만 listen한다고 설명한다.

### Docker-only disposable integration contract

1. PostgreSQL server는 Docker container에서만 실행한다. Run마다 충돌하지 않는 container와 Docker-managed named volume, 필요하면 network를 새로 만들고 재사용하지 않는다. Host bind는 `127.0.0.1`의 동적 port만 허용한다. Test credential은 run 중 생성해 repository나 log에 남기지 않는다.
2. 위 tag+index digest와 native target platform을 함께 지정하고 named volume을 `/var/lib/postgresql`에 mount한다. App schema용 init script를 `/docker-entrypoint-initdb.d`에 넣지 않는다. Image entrypoint는 empty `PGDATA`에 PostgreSQL cluster와 test DB를 초기화할 뿐이며 4개 auth domain table은 readiness 뒤 compiled JavaScript Migration의 단일 명시 실행만 만든다.
3. Readiness는 Migration이 쓸 것과 같은 host TCP 경로·database·user·password로 인증하고 bounded retry 안에서 `SELECT 1`이 성공해야 충족된다. Container running/health 상태나 `pg_isready`만으로 migration-ready를 주장하지 않는다. 이어서 server가 18.6이고 실제 child manifest digest가 선택 platform의 고정값인지 evidence에 남긴다.
4. 정상 종료, 관측 가능한 실패·timeout, 처리 가능한 `SIGINT`·`SIGTERM`에서는 `finally` 성격의 teardown을 수행한다. 각 자원에 run ownership ID를 붙이고 이번 run의 ID와 일치하는 exact container, named volume, network만 삭제해 부재를 확인한다. `SIGKILL`, host crash, Docker daemon 장애에서는 즉시 teardown을 보장하지 않으며 잔여 resource와 삭제 지연을 공개한다. 다음 실행의 recovery도 알려진 run ownership ID가 일치하는 exact resource만 회수한다. Global prune, 이름 pattern에 의한 광역 삭제, 기존·운영 resource 삭제를 금지한다. Disposable volume 삭제는 test fixture teardown이며 [`auth-database.md`](auth-database.md)의 revoked/idle session과 OAuth row cleanup·보관 정책을 실행하거나 바꾸는 것이 아니다.

후속 Worker는 target platform마다 다음 결과를 실제 실행 evidence와 구분해 기록한다. 한 native platform만 실행했다면 다른 platform은 미검증으로 남긴다.

| 검증 | 실행과 통과 기준 |
| --- | --- |
| Fresh apply | App relation이 없는 새 test DB에서 compiled ESM DataSource/Migration을 한 번 명시 실행한다. `auth-database.md`의 auth domain table은 정확히 4개다. 별도의 TypeORM Migration history metadata는 실행 기반 내부 table로 구분하며 새 auth domain table 승인으로 세지 않는다. |
| Re-run no-op | 같은 Migration을 다시 실행해 pending Migration과 schema 변경이 없음을 확인한다. |
| Migration 목록·schema | Applied Migration 목록과 catalog를 조회해 column/nullability/collation, named unique·FK·CHECK, 일반 index와 partial unique index가 승인 contract와 일치하고 예상 밖 auth relation이 없음을 확인한다. `users(id)`, `auth_sessions(id)`, `auth_refresh_tokens(token_hash)`, `auth_login_requests(id)` 각각은 정확한 column 집합의 `PRIMARY KEY` constraint여야 하며 `UNIQUE NOT NULL`로 대체해 통과시키지 않는다. |
| 위반 거절 | 각각 격리한 transaction에서 duplicate provider identity·미소비 refresh, orphan FK, nonempty/시간/revoked pair/hash/status별 CHECK, partial unique 위반이 해당 constraint/index에서 거절되고 rollback 뒤 fixture가 오염되지 않음을 확인한다. |
| 자동 schema 변경 없음 | `synchronize:false`, `migrationsRun:false`로 app을 시작·종료한 전후 catalog가 동일해야 한다. App 시작이 fresh DB에 auth table이나 Migration history를 만들지 않고 migrated DB도 바꾸지 않는다. |
| Disposable rollback | 별도의 빈 disposable test DB에 Migration up을 먼저 명시 적용해 auth schema와 applied history를 확인한 뒤 down을 실행한다. Auth domain table 제거와 Migration history의 일관성을 확인하며 빈 DB에서 즉시 down한 no-op를 성공으로 세거나 운영 destructive down의 근거로 사용하지 않는다. |

`auth-database.md`의 transaction manager, user→session→refresh 및 OAuth 선행 잠금 순서, lock 뒤 fresh time 재확인, cleanup/terminal null·삭제 의미는 그대로다. 위 matrix가 그 runtime 경합을 이미 검증했다고 표시하지 않으며 관련 flow 구현 때 별도 Docker integration evidence가 필요하다.

### 갱신 gate

PostgreSQL current minor/security release와 major 지원 상태, base OS의 full/LTS 지원 상태, official tag의 index 또는 target child digest, base variant, target platform, `PGDATA`/`VOLUME` 의미가 바뀌거나 실제 ESM/DB matrix가 실패하면 선택을 재검토한다. Tag/digest/version 교체는 새 dated metadata와 전체 matrix 계획을 포함한 Rule proposal로 다시 승인받는다. 고정 digest가 재현하는 오래된 bytes를 보안 update 대신 계속 사용하지 않는다.

## 승인된 Migration 계약

- `synchronize:false`, `migrationsRun:false`로 앱 시작이 schema를 자동 변경하지 않는다.
- TypeORM compiled JavaScript DataSource/Migration CLI로 승인된 tsc→Node ESM 실행을 유지한다. ts-node/Nest CLI나 새 runner를 추가하지 않는다.
- 최초 Migration은 [`auth-database.md`](auth-database.md)의 4개 테이블·named FK/CHECK/index를 만든다. 새 DB apply, 재실행 no-op, 직접 constraint 위반 거절, Migration 목록/schema를 후속 검증한다.
- 배포 담당의 단일 명시 실행으로 transaction 적용하며 동시 자동 실행을 금지한다. 운영 destructive down을 자동 실행하지 않는다. Rollback 검증은 빈 disposable test DB에 한정한다.
- 운영 변경은 검토한 forward migration/백업 절차의 별도 승인을 따른다. DB credential·key/provider 필수 설정은 해당 module을 연결할 때부터 listen 전에 값/stack 없이 정제 검증한다. 미연결 runtime-only app에 이 설정을 요구하지 않는다.

Migration의 문서 근거는 #39가 읽은 [TypeORM Migration setup](https://typeorm.io/docs/migrations/setup/)이며 선택 version의 실제 CLI·ESM 검증이 남아 있다. 이번 사용자 지시에 따라 Migration file/command/package script를 추가하거나 실행하지 않는다. 위 proposal이 승인되더라도 별도 구현 착수 지시를 뜻하지 않는다.

## 기본 API의 배포 설정 입력 — 승인됨

```yaml
status: active
enforcement: approval-required
rationale: 기본 API 실행에 필요한 기존 factory 설정의 직렬화 입력과 historical secret 참조 해석을 확정한다.
evidence: "PR #128 사용자 승인: https://github.com/blahaj94/ldb/pull/128#issuecomment-5572382154"
exceptions: 실제 credential·등록값·secret 저장소 제품·배포 topology와 Discord PKCE gate는 이 제안으로 확정하지 않는다.
review-after: 기본 entry의 설정 실패·전체 HTTP 흐름·자원 정리 검증 완료 또는 첫 설정 교체 검토 시
```

이 절은 [PR #128의 사용자 승인](https://github.com/blahaj94/ldb/pull/128#issuecomment-5572382154)을 반영한 active 계약이다. 실제 구현·검증 완료와 구분하며, 실행 범위는 [Issue #125](https://github.com/blahaj94/ldb/issues/125)와 [`change-control.md`](change-control.md)를 따른다. 승인된 선택은 배포가 준비한 **단일 secret JSON 파일**을 시작 때 한 번 읽는 방식이다. 이미 승인된 factory의 설정 전달 경계를 연결하며 새 dependency·API·DB schema를 추가하지 않는다.

### 환경변수와 파일 경계

- 기존 `PORT`, `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`, `NEOPLE_API_KEY` 입력과 검증 의미를 유지한다. 로그인·계정·검색을 합성한 기본 start에서는 모두 필수다. DB 값은 기존 DB reader로 읽고 이 JSON에 중복 저장하지 않는다.
- 새 필수 환경변수 `AUTH_CONFIG_FILE`은 배포가 준비한 파일의 **절대 filesystem path**다. 누락·빈 값·상대 경로·파일 읽기 실패는 시작 실패다. API는 경로를 trim하거나 환경변수·`~`·URL로 확장하지 않는다. 기본 경로, inline JSON 환경변수와 다른 설정 원천으로의 fallback은 없다.
- 파일은 UTF-8 JSON object이며 아래 필드를 가진다. JSON 문법 오류, 필수 필드 누락·잘못된 type·정의하지 않은 필드는 거절한다. 문자열·숫자 coercion과 값 보정은 하지 않는다. PEM의 줄바꿈은 JSON 문자열 escape로 전달한다.
- 파일 전체를 secret으로 취급한다. 배포 담당이 API 실행 주체와 필요한 배포 관리자만 읽도록 준비하며 source·DB·image layer·log에 넣지 않는다. API가 파일 생성·권한 변경·secret manager 호출을 맡지 않는다. 실제 저장소 제품, mount·소유자·OS 권한 설정과 운영 교체 절차는 별도 배포 gate다.
- 시작마다 파일을 한 번 읽어 검증된 설정 사본을 해당 process 수명 동안 사용한다. 요청 중 파일을 다시 읽거나 자동 reload하지 않는다. 교체는 일관된 새 파일을 준비한 뒤 process를 재시작하는 경계이며, 실행 중인 process가 파일 교체를 즉시 반영한다고 주장하지 않는다.

### JSON 필드와 기존 factory의 대응

아래 object의 필드는 별도 표시가 없으면 모두 필수다. `[]`는 배열 원소의 형태를 나타내며 실제 field 이름이 아니다. 등록·key의 값과 URL은 배포 담당이 준비하고 예제 credential을 기본값으로 사용하지 않는다.

| 경로 | 정확한 구조와 해석 |
| --- | --- |
| 최상위 | `accessJwt`, `providerPkce`, `registry`, `google` object 네 개. |
| `accessJwt` | `issuer: string`, `audience: string`, `signingKey: {kid: string, privateKeyPem: string}`, `verificationKeys: [{kid: string, publicKeyPem: string}]`. 기존 `AccessJwtIssuerConfiguration` 그대로이며 issuer와 verifier에 같은 issuer/audience/verification key 집합을 제공한다. |
| `providerPkce` | `activeKeyId: string`, `keys: [{id: string, key: string}]`. `key`만 canonical unpadded base64url 43자에서 정확한 32-byte Buffer로 decode/re-encode 확인 후 기존 `ProviderPkceConfiguration`에 전달한다. JWT signing key와 별도 key다. |
| `registry` | `apiOrigin: string`, `activeVersions: {google: string}`, `registrations: [ProviderRegistration]`. 기본 entry는 Google 로그인만 연결한다. Discord 활성화나 등록을 이 입력으로 허용하지 않으며 기존 Discord gate를 유지한다. |
| `registry.registrations[]` | `provider: "google"`, `version: string`, `providerClientId: string`, `providerSecretRef: string`, `callbackUrl: string`, `authorizationEndpoint: string`, `expectedAudience: string`, `returnTarget: {id: string, url: string}`. 기존 `LoginRegistryConfiguration`·`ProviderRegistration`의 Google 구조이며 active와 필요한 과거 version을 함께 담는다. |
| `google` | `registrations` 배열과 `secrets` 배열. Transport 함수나 `fetch` override는 파일 입력에 없다. |
| `google.registrations[]` | `version: string`, `tokenEndpoint: string`, `jwksUri: string`. 같은 version의 Google registry 항목 전체를 `snapshot`으로 찾아 기존 `GoogleProviderRegistration`에 전달한다. Snapshot을 이 배열에 다시 복제하거나 필드별로 덮어쓰지 않는다. |
| `google.secrets[]` | `version: string`, `reference: string`, `value: string`. `reference`는 같은 version의 `providerSecretRef`와 exact match하는 불투명한 식별자다. `value`는 비어 있거나 공백뿐인 문자열을 거절하고 통과한 문자열을 그대로 사용한다. 참조를 환경변수명·파일 path·URL로 실행하거나 해석하지 않는다. |

JWT·PKCE·registry의 의미 검증은 기존 `createAccessJwtIssuer`, `createAccessJwtVerifier`, `ProviderPkceKeys`, `LoginRegistry`를 재사용한다. JSON 경계는 위 구조를 확인하며 key import·일치·등록 URL·audience 검증을 별도 crypto나 느슨한 validator로 대체하지 않는다. Type 정의 위치는 `apps/api/src/auth/access-jwt/types.ts`, `apps/api/src/types/login.ts`, `apps/api/src/auth/google/types.ts`다.

### 등록 snapshot과 secret의 결합

- 각 `registry.registrations` version에 Google endpoint 항목 하나와 해당 `(version, providerSecretRef)` secret 항목 하나가 있어야 한다. 중복 Google endpoint version·중복 secret `(version, reference)`·누락·연결할 registry가 없는 항목은 listen 전에 실패한다. 문자열 exact match를 사용하고 구분자 결합으로 서로 다른 tuple이 충돌하게 만들지 않는다.
- Google authorization/token/JWKS URL은 배포 담당이 검토한 trusted registry/discovery allowlist 값이다. 기존 factory의 HTTPS·exact URL 검증을 유지한다. 파일은 신뢰된 서버 설정이며 요청·provider token의 URL이나 `jku`/`x5u`에서 값을 채우지 않는다. URL 형태 검증만으로 Google의 실제 등록·신뢰 근거 확인이 완료됐다고 표시하지 않는다.
- `resolveSecret({version, reference, signal})`은 시작 때 확정한 정확한 tuple만 조회한다. 취소된 signal 또는 일치 항목 부재는 실패이며 active version·같은 reference의 다른 version·첫 항목으로 fallback하지 않는다. Callback은 저장 snapshot과 동일한 provider client ID·callback·audience·secret 결합을 사용한다.
- 과거 snapshot을 지원하려면 registry, 해당 endpoint와 secret, 복호화 key를 함께 준비한다. 제공하지 않은 과거 snapshot이나 key의 pending request는 기존 실패 경로를 따르며 새 active 설정으로 재해석하지 않는다. 같은 version의 tuple 또는 secret 의미를 교체해 과거 request를 다른 설정에 연결하지 않는다.
- 정상 signing key의 90일 주기·public key 선배포·마지막 발급 뒤 최소 900초와 token 만료 확인 후 제거, 침해·복원 예외는 [`auth-session.md`](auth-session.md#signing-key-lifecycle)를 따른다. PKCE 이전 key의 pending 최대 10분 보존 또는 해당 request 명시 실패는 [`auth-database.md`](auth-database.md#provider-pkce-암호화)를 따른다. 시작마다 key를 생성하거나 이 파일 방식으로 기존 교체·보관 의미를 바꾸지 않는다.

### 시작 실패와 종료

1. 환경변수·파일 구조·key·registry·Google endpoint/secret 연결을 모두 검증한 뒤 DB와 앱을 초기화하고 마지막에 listen한다. 시작 검증을 위해 실제 provider 인증이나 자동 Migration을 실행하지 않는다.
2. 누락·잘못된 설정과 초기화·listen 실패는 nonzero exit로 끝낸다. 설정 실패에서는 port를 열지 않는다. 오류 원문·cause·stack·파일 경로·설정값·credential을 출력하지 않고 비민감 고정 실패 메시지만 남긴다. Framework와 library의 기본 오류 출력도 같은 경계로 처리한다.
3. 정상 종료·처리 가능한 `SIGINT`/`SIGTERM`·부분 초기화 실패·listen 실패 모두 이번 실행이 소유한 자원을 정리한다. 앱이 존재하면 앱 종료와 검색 취소 정리를 먼저 시도하고 그 뒤 DB 연결을 정리한다. 앱 종료 실패도 DB 정리를 건너뛰게 하지 않으며 초기화 완료 표시 이전에 확보된 연결도 정리 대상이다. 강제 종료·host 장애의 즉시 정리는 보장하지 않는다.

HTTP 합성은 기존 login/session/account/search factory를 사용한다. [`auth-activity.md`](auth-activity.md)의 단일 2초 DB deadline·취소·residual 검색과 [`character-search.md`](character-search.md#deadline과-adapter)의 5초 upstream deadline은 그대로 유지한다. 기본 entry에 인증 우회·test mode·실제 credential을 상속하는 test 설정은 추가하지 않는다.

### 비교한 대안과 선택 이유

대안은 registry·metadata JSON과 개별 secret 파일을 분리하고 metadata에서 secret 파일을 참조하는 방식이다. Secret별 읽기 권한과 교체 단위를 분리할 수 있지만 참조 path의 기준·허용 범위, 여러 파일의 읽기 실패·교체 중 일관성, 과거 version과 secret 파일의 수명까지 추가로 정하고 검증해야 한다.

단일 파일은 기존 typed factory 입력을 작은 loader로 변환하고 한 번 읽은 설정의 결합을 유지하기 쉽다. 반면 metadata만 바꿀 때도 secret을 포함한 파일을 다시 배포하며 파일을 읽을 수 있는 주체는 그 안의 모든 secret을 읽을 수 있다. 현재 기본 API 연결 범위에는 이 비용을 수용하는 안이 승인됐다. 서로 다른 권한·교체 주체가 실제로 필요해지면 분리안이나 secret manager adapter를 새 Rule 변경으로 검토한다.

## 승인과 미결정 gate

API/security/schema/보관·key 주기·활동 분류·admission/DB 장애·body/deadline 정책은 승인됐다. PostgreSQL server·image·local validation 선택의 상태와 evidence는 위 canonical 구간만 따른다. 선택 승인 여부와 별개로 다음 미정이 필요한 구현은 별도 결정/검증을 완료해야 한다.

- 운영 deployment topology와 single process 조건, clock 동기화·역행 감지, 실제 cleanup 시각·key 운영 절차
- 실제 선택한 dependency 조합의 compiled ESM/TypeScript/runtime compatibility
- 실제 client/HTTPS callback/protocol 등록값·provider config snapshot, Electron OS 저장/IPC의 실제 구현·browser/OS 검증. Desktop 설계와 남은 platform gate는 승인된 [Desktop contract](desktop-auth.md)를 따름
- Discord 일반 confidential OAuth PKCE의 공식 적용 근거와 후속 wrong/missing verifier·downgrade 거절 E2E
- 공개 ingress/pending-request·인증 전 abuse·서비스 전체 limiter 수치와 기존 quota와의 통합 순서
- [승인된 탈퇴 contract](auth-withdrawal-proposal.md)의 실제 provider/control store 내구성·writer fencing·사본 inventory/폐기·clock·incident 대응과 복원 E2E. D1–D5 정책 선택은 승인됐으며 실제 환경·구현/통합 검증은 미완료

탈퇴의 정책 승인과 남은 운영/구현 gate를 구분한다. 위 환경 gate는 로그인 핵심 설계 완료를 막지 않으며 탈퇴 Rule 승인은 제품 구현·provider 호출·백업/복원 실행의 자동 착수 지시가 아니다. 사용자가 Rule 승인과 함께 구현 금지를 명시했으므로 `change-control.md`의 승인 뒤 같은 PR Red/Green 일반 순서를 자동 착수 지시로 해석하지 않는다. 후속 구현은 별도 착수 지시·task 범위와 승인 evidence를 확인해 Red→Green과 관련 validation을 수행한다.
