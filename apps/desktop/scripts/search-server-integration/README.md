# Desktop 검색의 실제 서버 소비 검증

Desktop `createSearchHttp`가 실제 `apps/api/dist/main.js`와 연결되는지 확인한다. 기존 API 도구로 승인된 PostgreSQL image를 검증하고 고유 container·volume을 생성해 migration을 적용한다. Google/JWKS·Neople만 loopback fixture이며 로그인 요청·PKCE·callback·exchange·JWT 발급·session·검색 활동·quota는 실제 API와 DB를 사용한다.

Repository root에서 실행한다. Docker가 실행 중이어야 하며 설치된 workspace dependency를 사용한다.

```bash
pnpm --filter @ldb/api build
pnpm --filter @ldb/desktop exec vitest run --config scripts/search-server-integration/vitest.config.ts
pnpm --filter @ldb/desktop exec eslint scripts/search-server-integration
pnpm --filter @ldb/desktop exec tsc --noEmit --allowJs --strict --skipLibCheck --esModuleInterop --moduleResolution bundler --module esnext --target es2023 scripts/search-server-integration/search.integration.ts scripts/search-server-integration/vitest.config.ts
node --check apps/desktop/scripts/search-server-integration/runtime.mjs
```

전용 `*.integration.ts`는 일반 Desktop test의 기본 pattern에 포함되지 않는다. 전용 config는 forks process 하나에서 실행하며 서버 시작 helper 호출 동안만 cwd를 API로 변경하고 즉시 복원한다. API는 build된 ESM을 실행하므로 Nest decorator를 Vitest에서 다시 변환하지 않는다. Node helper는 syntax·lint와 실제 소비 실행으로, TypeScript test/config와 소비 type은 별도 `tsc`로 확인한다. JavaScript helper에서 TypeScript 반환형 문법만 lint 대상에서 제외한다.

검증하는 결과는 기본 query `characterName`만 전송했을 때의 서버 기본값 `all`·10·`full`, 다섯 field·순서·0명성·음수 소수·미등록 서버·누락 명성, 0건, 잘못된 upstream 후보의 전체 실패, 400·401의 upstream 0회, 실패 예약을 포함한 10회 뒤 429와 양의 Retry-After 소비다. Session 활동은 exchange와 다른 정수 초에서 갱신되고 quota 거절에서는 유지되는지 확인한다.

HTTPS origin 검사는 제품 그대로 유지한다. 검증 fetch만 고정 synthetic HTTPS origin을 소유 loopback API에 대응시키며 다른 origin/path를 거절한다. API child에는 기존 helper의 synthetic 환경 allowlist와 명시적 `--import`만 전달하고 실제 credential·사용자 `NODE_OPTIONS`를 상속하지 않는다. Token·원문 응답·private key를 출력하지 않는다.

종료 시 API SIGTERM의 정상 exit·HTTP close·실제 DB disconnect와 출력 없음을 확인하고, finally에서 upstream·DB connection·소유 container/volume을 정리한다. 기존 helper가 임시 인증 설정 파일 삭제와 container/volume 부재를 확인한다. 중간 실패에도 각 자원의 정리를 시도한다.

이 결과는 HTTP 클라이언트 경계에 한정된다. Shared refresh, 단일 15초 전체 예산, slot·IPC·renderer·실제 media/OCR, 외부 Google/Neople credential, 운영 TLS·배포 성공을 대신하지 않는다. 서버 구현과 추가 실행 범위는 [기본 API 설정과 실행](../../../../docs/reference/api-start-development.md), [인증된 검색 개발](../../../../docs/reference/authenticated-search-development.md)을 따른다.
