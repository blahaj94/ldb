---
type: reference
scope: apps/api database development
last-reviewed: 2026-09-06
---

# Schema First database 개발

API는 TypeORM `EntitySchema`를 먼저 수정하고 PostgreSQL과의 차이로 Migration을 생성한다. `apps/api/src/database/schemas`가 현재 ORM mapping이며, `apps/api/src/database/migrations`는 검토한 변경 이력이다. Schema file은 TypeScript interface와 column·PK·FK·unique·CHECK·index를 함께 정의한다. 새 dependency 없이 기존 TypeORM 1.1.1을 사용한다.

[Nest database 가이드](https://docs.nestjs.com/techniques/database)의 EntitySchema와 Migration 구성을 따른다. EF Core의 model → migration → database update와 유사하지만, TypeORM은 EF의 ModelSnapshot 대신 **접속한 DB catalog와 현재 EntitySchema**를 비교한다. 따라서 생성에 사용할 개발 DB는 먼저 기존 Migration이 모두 적용된 상태여야 한다.

## 작성과 적용

DB command는 `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` 설정을 사용한다. 값은 local 환경에서만 제공하고 source·문서·log에 기록하지 않는다.

1. Local 개발 DB에 기존 Migration을 적용해 비교 기준을 준비한다.

   ```bash
   pnpm --filter @ldb/api db:migrate:up
   ```

2. `apps/api/src/database/schemas`의 해당 EntitySchema와 TypeScript interface를 수정한다. 예를 들어 `users.ts`에서 property와 column mapping을 먼저 작성한다. Schema 의미를 바꾸는 작업의 승인 절차는 `docs/rules/change-control.md`를 따른다.
3. 의미를 설명하는 PascalCase 이름으로 Migration을 생성한다.

   ```bash
   pnpm --filter @ldb/api db:migrate:generate AddUserField
   ```

   이 command는 tsc build 후 compiled ESM generator를 실행하고 `apps/api/src/database/migrations/<timestamp>-AddUserField.ts`를 새로 쓴다. DB schema와 history를 변경하지 않는다. 차이가 없으면 `Database schema is current`를 출력하고 file을 만들지 않는다. 기존 file은 덮어쓰지 않는다.

4. 생성된 `up`과 `down`을 검토하고 관련 test를 추가한다. Column rename을 drop/add로 해석하는 경우와 data 변환·기존 row의 NOT NULL 전환 등은 생성 SQL의 data 보존 여부도 검토한다. Generator가 domain 의도나 data 변환을 결정하지 않는다.
5. 승인·검토한 Migration을 명시적으로 적용하고 상태를 확인한다.

   ```bash
   pnpm --filter @ldb/api db:migrate:up
   pnpm --filter @ldb/api db:migrate:show
   ```

6. API build·lint·test·typecheck와 `pnpm --filter @ldb/api test:database`를 실행한다. `db:migrate:down`은 빈 disposable DB의 rollback 검증용이며 운영에서 자동 실행하지 않는다.

Migration은 build된 `database/migrations/*.js`에서 자동 발견되므로 새 class를 별도 목록에 수기 등록하지 않는다. `show`는 등록된 전체 Migration을 history와 대조하며 fresh DB에 history table을 만들지 않는다. App과 CLI 모두 `synchronize:false`, `migrationsRun:false`를 유지한다. Migration 적용은 명시적 transaction이며 Nest lifecycle은 schema를 수정하지 않는다.

## ORM 사용

Schema 자체를 repository target으로 사용한다. Nest 기능 module을 연결할 때는 `TypeOrmModule.forFeature([UserSchema])`로 등록할 수 있다. 기본 runtime-only AppModule은 아직 DB module을 연결하지 않는다.

```ts
import { UserSchema } from './database/schemas/users.js'

const users = dataSource.getRepository(UserSchema)
const user = await users.findOneBy({ provider, providerSubject })
```

`providerSubject` 같은 camelCase property는 기존 `provider_subject` DB column에 mapping된다. Transaction 안에서는 동일한 transaction manager의 `getRepository(UserSchema)`를 사용한다. API가 UUID를 생성하며 DB extension이나 자동 UUID default는 추가하지 않는다.

## 이력과 생성 한계

- 이미 작성된 초기 Migration은 기존 이력으로 보존한다. 이후 EntitySchema를 수정해도 과거 Migration이 바뀌지 않도록 Migration에서 현재 schema file을 import하지 않는다.
- TypeORM 1.1.1의 schema diff는 같은 이름의 CHECK expression 및 partial index의 WHERE 변경을 감지하지 않는다. 이런 표현을 변경할 때는 schema의 해당 constraint/index 이름도 새 이름으로 바꾸어 drop/create가 생성되도록 하고, 생성 SQL과 실제 위반 거절을 확인한다. PK 이름 변경 같은 metadata 변경 역시 SQL에 반영됐는지 확인한다.
- `Database schema is current`는 TypeORM이 감지한 차이가 없다는 뜻이다. 모든 DB invariant가 같다는 증거로 대신 쓰지 않는다. 실제 DB test는 column/collation/precision, constraint definition, PK/FK/unique/index와 위반 거절도 따로 검증한다.
- Generator는 TypeORM의 `createSchemaBuilder().log()`를 사용한다. 기본 CLI template의 일반 type import와 raw 오류 출력 대신 이 repository의 `import type`, transaction guard, 정제된 오류 출력을 유지하는 작은 writer를 사용한다.

## 현재 검증 범위

`apps/api/test-support/schema-first.mjs`는 별도 disposable DB에 EntitySchema에서 생성한 초기 Migration을 적용하고 기존 초기 Migration과 PostgreSQL constraint definition을 대조한다. 네 schema의 ORM 저장/조회·FK cascade, 적용 뒤 diff 없음, 임시 nullable column의 후속 Migration 생성·적용·rollback을 검증한다. 생성 file은 임시 directory에서 compile하며 test가 끝나면 삭제한다.

Docker image는 고정 index·native child·config를 검증한 뒤 같은 local image inspect의 ID를 container `.Image`와 비교한다. Classic store의 config ID와 containerd store의 index ID 차이를 허용하면서 검증한 image와의 정확한 일치를 요구한다. 실제 Docker 검증은 native `linux/arm64/v8`에서 수행했으며 `linux/amd64`와 classic store 실기 검증은 별도다.

## AuthLoginRequest 구조와 보존 검증

`AuthLoginRequest`는 평면 property를 유지하는 Data Mapper target이다. 수정할 정의는 다음 세 file에서 찾는다.

| File | 책임 |
| --- | --- |
| `apps/api/src/database/schemas/auth-login-requests.ts` | 공개 TypeScript interface, EntitySchema 조립, UNIQUE와 index 이름 |
| `apps/api/src/database/schemas/auth-login-request.columns.ts` | 식별 정보·수명주기·client PKCE·browser 문맥·provider PKCE·교환 결과와 소비 시간의 여섯 column group |
| `apps/api/src/database/schemas/auth-login-request.checks.ts` | 값 규격, field 묶음/시간 관계, 상태별 CHECK |

Column group은 TypeORM 옵션 객체와 spread를 사용한다. `EntitySchemaColumnOptions`, `EntitySchemaOptions<AuthLoginRequest>['columns']`와 `satisfies`가 옵션·property key·전체 column 누락을 검사한다. `text`, `nullableText`, `nullableBinary`, `timestamp`, `nullableTimestamp`만 해당 table 내부에서 재사용한다. 새로운 naming strategy·embedded·ORM wrapper는 없으며 기존 DB column명과 선언 순서도 유지한다.

CHECK에서 실제로 반복되던 진행 중 앱 proof, browser_started/processing의 동일한 claim 조건, consumed/failed의 credential 정리 조건을 각각 local SQL constant로 공유한다. 상태별 constraint 이름과 wrapper, 마지막 consumed_at 조건은 명시적으로 남긴다. 결과 SQL은 기존 표현과 공백까지 같다. 특히 `method IS NOT NULL`은 SQL UNKNOWN 우회를 막으므로 `method = 'S256'`이 있다는 이유로 제거하지 않는다. 앞으로 두 상태의 정책이 달라지는 승인된 변경에서는 공통 fragment의 영향 범위를 확인하고 해당 조건을 분리한다.

API의 TypeORM `1.1.1`, `@nestjs/typeorm` `12.0.1`, TypeScript `5.9.3`은 package와 lockfile에서 확인했으며 이 refactor에서 변경하지 않았다. 별도 naming strategy가 없고 TypeORM 기본 strategy는 property를 snake_case column으로 바꾸지 않으므로 기존 `name`을 유지한다. UUID는 API 생성 책임, 시간은 기존 `timestamptz`·`precision: 0`·기본값 없음, nullable/type·UNIQUE/index/constraint 이름은 그대로다. 기존 Migration을 수정하거나 새 Migration을 추가하지 않는다.

Production auth 쓰기/전이 service는 아직 없다. 따라서 감쌀 복잡한 조건부 UPDATE가 없으며 Generic Repository나 새 기능별 Repository를 미리 만들지 않는다. 현재 직접 Repository 사용은 DB integration fixture에서 동일 transaction manager를 통해 이뤄진다.

`apps/api/test/fixtures/auth-login-request-schema.json`은 구조 변경 전 `8614006`의 독립 metadata snapshot이다. `apps/api/test/auth-login-request-schema.test.ts`는 모든 column 옵션·flat property·선언 순서·UNIQUE/index와 23개 CHECK의 이름/SQL을 대조한다. 현재 schema/helper에서 기대값을 다시 만들지 않는다. Schema 의미가 변경되는 후속 작업에서는 승인된 migration과 DB behavior test를 먼저 검토하고 fixture를 명시적으로 갱신한다.

`apps/api/test-support/auth-login-request-contract.mjs`는 기존 migration을 적용한 PostgreSQL과 EntitySchema에서 생성한 schema 각각에서 정상 15개·거절 96개를 확인한다. 여섯 상태의 두 provider 정상 행, 필수 field별 NULL, 금지 field별 잔존, hash 31/33-byte, PKCE ciphertext/IV/tag/key 길이, unique hash 중복을 검사한다. 리팩터링 전 기준과 이후 모두 통과했고 기존 drift와 새 drift는 모두 없었다. Native diff와 별도로 PostgreSQL constraint definition 및 정확한 SQL snapshot을 비교한다.

### 유지한 정책 관찰점

아래는 이번 구조 변경에서 발견한 기존 허용 범위이며 새 정책 결정이 아니다.

- `exchange_ready`는 state/browser binding/nonce/provider PKCE가 정리된 행과 남아 있는 행을 모두 허용한다. Terminal의 일괄 NULL 정리 조건을 이 상태로 확대하지 않았다.
- Google nonce는 `browser_started`와 `processing`에서 필수다. Discord는 NULL 또는 32-byte nonce를 모두 허용하고, `exchange_ready`의 nonce는 optional이다.
- DB 시간 CHECK는 request의 `expires_at > created_at`, code의 `code_expires_at <= expires_at`와 상태별 null 여부를 검사한다. `consumed`에는 consumed_at이 필요하고 `failed`에는 NULL이어야 한다. 최대 TTL·현재시각 만료·single-use와 전이 경합은 DB의 이 CHECK만으로 보장하지 않으며 후속 runtime 계약의 책임이다.

이 범위를 좁히는 변경은 이번 refactor에 포함하지 않았다. Native arm64 PostgreSQL 18.6에서 검증했으며 amd64·운영 DB와 아직 없는 auth service의 동시성/만료 실행은 미검증이다.
