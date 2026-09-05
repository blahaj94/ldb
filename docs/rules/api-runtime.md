---
type: rule
status: active
enforcement: approval-required
scope: apps/api
last-reviewed: 2026-09-05
rationale: 검색 구현이 runtime과 검증 도구를 추측해 추가하지 않도록 승인 경계를 정한다.
evidence: "PR #42 사용자 승인: https://github.com/blahaj94/ldb/pull/42#issuecomment-5550598698"
exceptions: 사용자 승인 전에는 dependency 설치와 실행 기반 구현을 허용하지 않는다.
review-after: API 실행 기반의 첫 validation 완료 또는 지원 major 변경 시
---

# API Runtime Contract

이 문서는 [PR #42의 사용자 승인](https://github.com/blahaj94/ldb/pull/42#issuecomment-5550598698)을 반영한 Rule이다. API runtime·아래 dependency·검증 계약이 승인 범위이며, 구현은 해당 Execution Issue와 [`change-control.md`](change-control.md)의 Red→Green 절차를 따른다. 승인 범위 밖 dependency·architecture 변경은 별도 승인 대상이다.

## 결정의 상태

| 구분 | 내용 |
| --- | --- |
| RFC에서 논의한 방향 | `apps/api`의 NestJS, 중앙 API, 검색 DB 저장·캐싱 없음 |
| 승인된 실행 계약 | Node 24 LTS, Nest 12, ESM과 TypeScript build, 아래 dependency·test 방식 |
| 이번 안에서 결정하지 않음 | 인증·session·DB·운영 배포, 실제 credential과 domain, 전체 서비스 한도 |

설계 작성 시점의 `apps/api/package.json`은 ESM이며 `dev`, `build`, `test`는 비어 있고 API source·test·tsconfig가 없다. 아래 command와 경로는 **향후 구현 계약**이며 현재 실행 가능한 command나 검증 성공 evidence가 아니다.

## Runtime과 dependency

API만 Node `>=24.15.0 <25`를 호환 floor/major 범위로 두며, 실제 선택은 해당 major의 최신 보안 patch로 한다. `@types/node`는 24.x로 맞춘다. Node 24는 확인 시점 LTS이며 기존 `pnpm@11.23.0`의 지원 Node 범위에 들어간다. 다른 app의 Node/types 버전이나 workspace package manager를 변경하지 않는다. [Node release 상태](https://nodejs.org/en/about/previous-releases), [pnpm 호환 표](https://pnpm.io/installation#compatibility)

다음 목록은 API workspace의 승인된 직접 dependency 목록이다. Nest package는 동일한 12.x release로 맞추며 확인 기준은 12.0.1이다. 후속 구현은 아래 major 범위 안에서 공개 package의 engine·peer를 재확인하고 실제 해결된 version을 lockfile에 기록한다. Major·역할 변경이나 목록 밖 직접 dependency가 필요하면 승인을 다시 받는다.

| 종류 | Package / 허용 범위 | 필요한 역할과 호환 근거 |
| --- | --- | --- |
| Runtime | `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`: 12.x, 동일 release | Decorator·DI·lifecycle·HTTP. Core의 Node engine은 `>=20`, peer는 Nest 12.x이며 platform은 Express 5를 포함한다. |
| Runtime | `reflect-metadata`: 0.2.x | TypeScript가 emit한 decorator metadata. Core/common peer의 `^0.1.12 \|\| ^0.2.0` 충족. |
| Runtime | `rxjs`: 7.x, `>=7.1.0` | Nest 필수 peer. 별도 reactive 도메인 구조를 도입하는 의미는 아니다. |
| Development | `typescript`: 5.9.x | 기존 Desktop과 같은 compiler minor. Source와 test를 같은 `tsc`로 build한다. |
| Development | `@types/node`: 24.x, `@types/express`: 5.x | 선택한 Node runtime과 Express request의 type; transitive type에 직접 의존하지 않는다. |
| Development | `@nestjs/testing`: 12.x, runtime과 동일 release | 실제 Nest container에서 test provider를 교체하고 HTTP app을 종료한다. 특정 test runner에 종속되지 않는다. |
| Development | `eslint`: 9.x, `@eslint/js`: 9.x, `typescript-eslint`: 8.x | 기존 ESLint major를 유지하는 API 전용 flat config. TS 5.9·Node 24·ESLint 9를 지원하는 8.x release를 선택한다. |

Nest 12는 ESM package이며 [공식 migration guide](https://docs.nestjs.com/migration-guide)는 runtime과 CLI의 Node 요구를 구분한다. 이 안은 CLI를 추가하지 않는다. Version별 engine·peer 근거는 [core 12.0.1](https://github.com/nestjs/nest/blob/v12.0.1/packages/core/package.json), [common](https://github.com/nestjs/nest/blob/v12.0.1/packages/common/package.json), [platform-express](https://github.com/nestjs/nest/blob/v12.0.1/packages/platform-express/package.json), [testing](https://github.com/nestjs/nest/blob/v12.0.1/packages/testing/package.json)다. Lint 호환 범위는 [typescript-eslint 공식 문서](https://typescript-eslint.io/users/dependency-versions/)를 따른다. 이는 문서상 호환 근거이며 설치·build 성공을 보장하는 실행 evidence가 아니다.

HTTP client는 Node 내장 `fetch`, test runner와 assertion은 `node:test`, `node:assert/strict`를 사용한다. Axios, Jest, Vitest, SWC, `tsx`, `ts-node`, Nest CLI, `class-validator`, `class-transformer`, config package는 이 범위에 추가하지 않는다. Query와 응답 경계는 [`character-search.md`](character-search.md)의 제한된 검증으로 표현한다.

## Build와 test 계약

- `apps/api/package.json`의 `type: module`을 유지한다. `tsconfig.json`은 `module`·`moduleResolution: NodeNext`, `target: ES2023`, `strict: true`, `experimentalDecorators: true`, `emitDecoratorMetadata: true`, `noEmitOnError: true`를 사용한다. 실행 시 필요한 class import는 type-only로 지우지 않는다.
- Relative source import에는 build 결과의 `.js` 확장자를 쓴다. Decorator module보다 먼저 `reflect-metadata`가 로드되게 하고, test도 같은 조건으로 실행한다. Runtime alias나 bundler가 필요한 path alias는 추가하지 않는다.
- `tsconfig.build.json`은 `src/**/*.ts`만 `rootDir: src`에서 `outDir: dist`로 emit한다. Entry는 `src/main.ts` → `dist/main.js`다. Test는 production 산출물에 넣지 않는다.
- `tsconfig.test.json`은 같은 compiler 옵션으로 `src/**/*.ts`, `test/**/*.ts`를 `rootDir: .`에서 `outDir: .test-dist`로 emit한다. Test 이름은 `test/**/*.test.ts`, 실행 대상은 `.test-dist/test/**/*.test.js`다. Typecheck는 source와 test를 함께 검사한다.
- 매 build/test compile 전에 해당 output만 `node:fs`의 `rmSync(..., { recursive: true, force: true })`로 정리해 삭제한 test나 source의 stale 산출물을 실행하지 않는다. 두 output은 Git에서 제외한다.
- Test는 native TS stripping이나 esbuild에 decorator 변환을 맡기지 않는다. `tsc` 선컴파일 후 Node를 실행해 production과 동일한 metadata를 검증한다. [TypeScript metadata](https://www.typescriptlang.org/tsconfig/emitDecoratorMetadata.html), [Node TS의 decorator 제한](https://nodejs.org/docs/latest-v24.x/api/typescript.html), [Node test runner](https://nodejs.org/docs/latest-v24.x/api/test.html)

대안인 Vitest는 Desktop과 runner를 공유하지만 Nest의 [공식 Vitest recipe](https://docs.nestjs.com/recipes/swc#vitest)에 필요한 SWC transform·metadata 구성을 추가로 관리해야 한다. 현재 작은 API는 선컴파일과 내장 runner를 사용한다. Nest test container는 [runner와 독립적](https://docs.nestjs.com/fundamentals/testing)이다.

## 실행과 검증 경계

App 생성은 port를 열지 않는 factory로 분리하고, `main.ts`만 설정 읽기·listen·종료 signal 연결을 담당한다. Test는 factory에 fake 설정/provider를 넣어 `127.0.0.1`의 port `0`에서 실행하고 반드시 `app.close()`한다. 정상 HTTP 검증용 route는 test module 안에 두며 제품용 health/API를 추가하지 않는다.

실행 기반의 최소 **필수** 설정은 `PORT`(십진 정수 1~65535)다. 누락·빈 값·잘못된 값은 listen 전에 실패한다. 따라서 runtime-only 단계에서도 실제 필수 설정 누락 실패를 검증한다. Test factory의 loopback port 0 주입은 환경변수 검증과 구분한다. 검색 구성에 필요한 `NEOPLE_API_KEY`는 검색 module을 연결할 때부터 필수이며 누락·빈 값은 listen 전에 실패한다. Runtime-only app은 아직 연결하지 않은 인증·DB·검색 설정을 요구하지 않는다. 필수 설정 실패는 값이나 stack을 출력하지 않고 검증한다. Fake 설정은 test에서만 주입하며 운영용 인증 우회나 test mode를 추가하지 않는다.

후속 구현의 표준 검증 command는 다음과 같다. Package script를 아래 동작으로 구현한 뒤 [`testing.md`](testing.md)의 Red→Green evidence를 기록한다.

| Root에서 실행할 command | 구현할 동작 / 통과 기준 |
| --- | --- |
| `pnpm --filter @ldb/api typecheck` | `tsc --noEmit -p tsconfig.test.json`; source·test type 오류 없음 |
| `pnpm --filter @ldb/api lint` | `eslint .`; source·test·config 검사, 생성 output 제외 |
| `pnpm --filter @ldb/api build` | `dist` 정리 후 `tsc -p tsconfig.build.json`; ESM `dist/main.js` 생성 |
| `pnpm --filter @ldb/api test` | `.test-dist` 정리 후 `tsc -p tsconfig.test.json`, `node --import reflect-metadata --test ".test-dist/test/**/*.test.js"`; 정상·실패·경계 test 수행 |
| `pnpm --filter @ldb/api start` | `node --import reflect-metadata dist/main.js`; build 후 실행 |
| `pnpm --filter @ldb/api dev` | `pnpm run build` 후 `pnpm run start`; 초기 범위에 watch orchestration을 추가하지 않음 |

Runtime acceptance에는 test HTTP 응답, metadata가 필요한 constructor DI, app 시작·종료 후 열린 handle 없음, child process의 build entry 실행과 종료, `PORT` 누락·빈 값·잘못된 값에서 nonzero exit·미listen을 포함한다. 검색 module 연결 후에는 해당 필수 설정 누락도 검증한다. Test의 child process는 허용한 fake environment만 받아 실제 credential을 상속하지 않는다. Build entry 검증에는 위 `build`가 선행해야 한다.

검색 adapter는 fake transport 또는 loopback upstream으로 검증한다. 외부 domain·네오플 credential·인증·DB가 필요하지 않아야 한다. 계정당 제한과 session 활동의 통합 검증은 해당 인증 Rule 승인 후 진행한다. Search query 길이의 외부 규격 미확인은 credential 없는 runtime 검증을 막지 않는다.

설계 검토 시에는 문서 대조와 `git diff --check`만 수행한다. 위 command, dependency 설치, API·DB·부하 검증은 설계 단계에서 실행하지 않는다. Runtime/test 조합의 첫 실행이 실패하면 engine·peer·metadata·ESM 원인을 공개하고, 이를 피하려고 승인 범위 밖 도구를 추가하지 않는다.

## Authentication runtime proposal — 미승인 추가 제안

인증·DB의 exact dependency 후보와 Migration은 [`auth-runtime.md`](auth-runtime.md), HTTP/parser 경계는 [`auth-api.md`](auth-api.md)를 참조한다. 이 routing과 후보는 위 승인된 직접 dependency 목록에 포함되지 않으며 새로운 설치·구현 authority를 만들지 않는다. 승인된 Node/Nest/ESM/tsc→Node 계약을 유지한 채 역할·후보와 남은 compatibility/운영 gate를 별도로 승인받아야 한다.
