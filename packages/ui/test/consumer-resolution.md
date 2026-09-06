# Cold consumer regression

[Issue #103의 재개 contract](https://github.com/blahaj94/ldb/issues/103#issuecomment-5561158338)는 library를 먼저 build하지 않은 checkout에서도 consumer command가 공용 UI를 해석하도록 요구한다. 기존 validation은 library 선행 build 뒤에 수행되어 이 조건을 검증하지 못했다.

## 실행과 격리

```sh
pnpm install --frozen-lockfile
node --test packages/ui/scripts/test-consumer-resolution.mjs
```

전용 checkout에서 직렬로 실행한다. 각 case 시작 전에 `packages/ui/dist`, consumer의 generated output 및 관련 Vite/TypeScript cache를 제거한다. 같은 checkout에서 dev server나 다른 build를 동시에 실행하지 않는다. 기존 artifact를 보존해야 하는 checkout에서는 실행하지 않는다. 설치된 dependency는 공유하되 이전 case의 library artifact는 사용하지 않는다.

Test는 기존 Node test runner·child process·fetch를 사용한다. 범용 command runner나 새 dependency 없이 실제 package script의 exit code와 dev server의 실제 source entry HTTP 응답을 검사한다. 단순 dist 존재 검사는 성공 기준이 아니다. POSIX process group 종료를 사용하며 현재 검증 환경은 macOS다.

Web·Desktop은 각각 `test`, `typecheck`, `build` script를 실행한다. Example의 typecheck와 test는 기존 `@ldb/ui typecheck`와 `test` 범위에 속하며 별도 Example 전용 script는 없다. Example `dev:examples`와 `build:examples`도 실행한다. Production preview는 consumer production build가 필요한 별도 경로다.

Desktop 제품 `dev`는 Electron bootstrap을 실행하므로 이 regression에서 직접 호출하지 않는다. 설치된 electron-vite 5의 `--rendererOnly`도 이전 main/preload를 실행한다. 대신 `apps/desktop/scripts/ui-renderer-resolution.mjs`가 공개 `resolveConfig` API로 실제 `electron.vite.config.ts`의 renderer 설정을 읽고 같은 Vite server로 실제 renderer entry를 해석한다. 부모 test가 HTTP 결과를 검증하고 자신이 시작한 child process group을 종료한다. 실패한 import 이후 Vite 7의 `server.close()` await가 원래 assertion을 가렸던 접근은 사용하지 않는다. 제품 main/preload·capture/OCR는 실행하지 않는다. 이 결과를 제품 native bootstrap 검증으로 주장하지 않는다.

## Red 근거와 다음 검증

기준 `1f2434b033662fd4dd7bf36181f05062398933a2`에서 Web·Desktop test는 App의 `@ldb/ui` import 해석, typecheck와 build는 같은 import의 TS2307로 실패한다. Web dev와 Desktop renderer dev에서도 `/src/App.tsx`가 import-analysis 오류로 HTTP 500을 반환한다. Test harness 설치 실패가 아닌 보고된 consumer integration defect다. Example은 기존 source alias와 TypeScript paths 덕분에 네 경로가 통과한다. 전체 12 case에서 8개의 예상 실패와 4개 통과를 확인한다.

Green에서는 package public API·source·CSS·runtime behavior를 유지하면서 consumer resolution을 연결한다. Final head에서 cold regression과 관련 lint·build artifact/고지를 확인한다. 기존 `docs/reference/ui-validation.md`의 전체 interaction·Theme·Motion·responsive matrix는 source·외형 불변을 확인한 범위에서 재사용하고, 바뀐 소비 경로는 별도 entry smoke로 확인한다.
