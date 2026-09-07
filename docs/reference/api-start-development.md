---
type: reference
scope: apps/api default entry and deployment configuration
last-reviewed: 2026-09-08
---

# 기본 API 설정과 실행

`pnpm --filter @ldb/api start`는 `apps/api/dist/main.js`에서 Google 로그인·refresh/logout·계정·인증 검색을 한 앱으로 시작한다. 기존 factory와 transaction을 사용하며 필수 설정을 검증한 뒤 DB를 초기화하고 마지막에 listen한다. 실제 provider 등록·credential과 운영 ingress/TLS·배포 검증은 별도로 준비해야 한다.

## 준비할 입력

| 환경변수 | 입력 |
| --- | --- |
| `PORT` | ASCII 십진 정수 `1`~`65535` |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` | 기존 DB reader의 개별 연결 값. `DB_PORT`도 십진 정수 `1`~`65535`이며 나머지는 비어 있지 않아야 한다. |
| `NEOPLE_API_KEY` | 비어 있지 않은 검색 API key |
| `AUTH_CONFIG_FILE` | 배포가 준비한 UTF-8 JSON secret 파일의 절대 경로 |

파일의 정확한 schema와 key 교체·과거 version 보존 기준은 [승인된 배포 설정 입력](../rules/auth-runtime.md)을 따른다. 최상위는 `accessJwt`, `providerPkce`, `registry`, `google` 네 object다. PEM은 JSON 문자열에, PKCE key는 canonical base64url 43자에 담는다. Google endpoint는 registry의 version을 참조하고 secret은 `(version, reference)`가 정확히 일치해야 한다.

운영 담당이 파일을 repository와 image 밖에 준비하고 API 실행 주체와 필요한 배포 관리자만 읽도록 관리한다. 기본 경로·inline JSON 환경변수·환경변수명으로 secret reference 해석·자동 key 생성은 없다. 현재 기본 entry는 Google 등록만 받으며 Discord gate는 유지한다. 실제 값은 문서·shell history·log에 기록하지 않는다.

## 시작과 교체

검토한 배포 입력을 process 환경에 주입하고 이미 승인된 Migration이 적용된 DB를 준비한다. 새 DB나 pending Migration에는 배포 담당이 `pnpm --filter @ldb/api db:migrate:up`을 한 번 명시 실행한다. API 시작은 Migration을 실행하거나 schema를 자동 변경하지 않는다.

Repository root에서 실행한다.

```bash
pnpm --filter @ldb/api build
pnpm --filter @ldb/api start
```

설정 누락·잘못된 JSON·key/registry/secret 연결 오류는 DB 연결과 listen 전에 실패한다. 초기화·listen 실패도 exit code 1이며 `API failed to start`만 출력한다. 오류의 원문·stack·파일 경로·설정값은 출력하지 않는다. 이 검증은 실제 Google/Neople credential의 유효성을 외부 서비스에서 확인하는 절차가 아니다.

파일은 시작 때 한 번만 읽는다. 설정을 바꿀 때는 필요한 과거 registry·secret·decrypt/verify key를 유지한 일관된 새 파일을 준비한 뒤 재시작한다. 진행 중 요청을 새 active version으로 대체하지 않으며, 지원하지 않는 과거 version은 기존 실패 경로를 따른다.

`SIGINT`/`SIGTERM`에서는 앱의 검색 취소와 종료가 끝난 뒤 소유 DB 연결을 닫는다. 초기화 중 signal은 기록하고 완료 후 listen을 건너뛴다. Listen 진행 중 signal은 해당 작업이 끝난 뒤 정리한다. 초기화 완료 표시 이전에 확보한 DB 연결도 실패 정리 대상이며 앱 종료 실패가 DB 정리를 막지 않는다. `SIGKILL`·host 장애의 즉시 정리는 보장하지 않는다.

## 구현과 검증 위치

| File | 책임 |
| --- | --- |
| `apps/api/src/main.ts` | 환경 전달, listen과 signal, 고정 실패 출력 |
| `apps/api/src/runtime/authentication-input.ts` | JSON의 정확한 object/field/type과 PKCE 문자열 해석 |
| `apps/api/src/runtime/configuration.ts` | 파일 1회 읽기, 기존 factory 검증과 version/secret 연결 |
| `apps/api/src/runtime/application.ts` | 기존 login/session/account/search 합성, 앱·DB의 수명 |
| `apps/api/src/auth/login/http.ts` | 기존 HTTP factory와 부분 앱 설정 실패의 정리 |
| `apps/api/test-support/runtime-startup.test.mjs` | 실제 build entry의 설정 거절·시작·실패·signal 종료 |
| `apps/api/test-support/runtime-http-integration.mjs` | 기존 Docker harness의 실제 DB·기본 entry·전체 HTTP 흐름 |

`runtime-preload.mjs`는 테스트 child의 `--import`에만 지정한다. 기존 synthetic Google/JWKS와 Neople loopback fixture에 transport를 대응시키고 부분 초기화 실패를 주입한다. 제품 source는 이 module과 테스트 환경변수를 읽지 않는다. 실제 credential·`NODE_OPTIONS`를 child에 상속하지 않는다.

```bash
pnpm --filter @ldb/api run --sequential '/^(lint|test|typecheck)$/'
pnpm --filter @ldb/api test:database
```

기본 entry만 반복 확인할 때는 `pnpm --filter @ldb/api test:database --runtime-only`를 사용한다. 기존 Docker 생성·image 검증·readiness·명시 Migration·정리를 그대로 사용하며 전체 DB matrix를 대체하지 않는다.

Worker의 2026-09-08 검증에서 startup 설정·실패·signal 검증과 focused DB/HTTP 검증이 통과했다. 실제 흐름은 pending Google 요청 → 재시작·active version 변경 → 과거 version의 callback/exchange → 계정 조회·수정 → 검색 → refresh/logout → 계정 거절·잔여 JWT 검색 → DB lock 대기 검색의 종료 취소다. Fresh DB의 schema 불변과 부분 연결·Nest 생성/설정·listen 실패의 backend 소멸도 확인했다.

환경은 Node `v24.19.0`, pnpm `11.23.0`, Docker server `29.7.2`, native `linux/arm64/v8`, PostgreSQL `18.6 (Debian 18.6-1.pgdg13+2)`다. 실제 provider/credential, `linux/amd64`, Desktop·공개 배포·proxy/APM·운영 복원은 이 검증에 포함하지 않았다. 최종 전체 API/DB 검증과 독립 review evidence는 구현 PR에서 exact head와 연결한다.
