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

### 종료 lifecycle의 별도 Node 검사

```sh
node --test --test-timeout=25000 packages/ui/test/consumer-process-lifecycle.node.mjs
```

이 파일은 Vitest의 jsdom 테스트와 분리한 Node 전용 검사입니다. 기존 cold 12개 검사를 실행하거나 generated output/cache를 제거하지 않습니다. 종료 helper는 `packages/ui/scripts/consumer-process-lifecycle.mjs`에 있으며, 공통 dev 3개 case가 이를 호출합니다.

Unit 8개는 정상 TERM, 이미 종료·부재, TERM 무응답, child 종료 후 group 잔존, KILL 이후 잔존, 확인 권한 오류, ESRCH 경합, 원래 검사 오류와 cleanup 오류의 동시 보존을 검사합니다. 가상 시계와 신호 주입으로 5초 TERM 유예, KILL 뒤 최대 2초, 50ms polling을 결정적으로 검사합니다. 실제 detached Node child 2개는 최초 TERM 종료와 TERM 무응답 경로의 신호·exit·group 부재 계약을 확인합니다. 실제 Vite 종료 실패를 반복 유도하는 검사는 아닙니다.

각 unit은 250ms, 실제 child의 종료 판정은 8초의 테스트 안전 제한을 둡니다. 실제 child는 준비 메시지를 보낸 뒤에만 종료 검사를 시작합니다. 테스트의 `finally`는 직접 생성한 detached group만 정리하고 child exit 및 group 부재를 확인합니다. 별도 안전장치로 synthetic child 자신도 12초 뒤 소유 group을 종료하므로 runner의 강제 종료가 무제한 잔존으로 이어지지 않게 합니다. 테스트 안전 정리는 helper의 성공으로 계산하지 않습니다. 외부 감독에서도 위 명령에 30초 제한을 둡니다.

종료 helper는 최초 SIGTERM 뒤 최대 5초 동안 child exit와 group 부재를 함께 확인합니다. 50ms 이하 간격으로 재확인하며, 제한을 넘기면 남은 소유 group에 SIGKILL을 보내고 최대 2초 동안 정리를 확인합니다. 제한 초과는 정리에 성공해도 실패로 남습니다. ESRCH 경합은 group 부재로 처리하지만 child exit도 확인해야 성공합니다. 권한 오류나 정리 확인 실패는 숨기지 않습니다.

HTTP/import/startup 오류가 있으면 harness가 그 오류를 그대로 다시 던집니다. cleanup도 실패하면 `AggregateError.errors`에 원래 오류와 cleanup 오류를 순서대로 담고 `cause`에는 원래 오류를 유지합니다. 두 실패가 없을 때만 정상 종료로 처리합니다. 이 helper는 호출자가 직접 `detached: true`로 생성한 child만 받으며, 임의 PID나 다른 프로세스 그룹에 대한 정리 도구로 사용하지 않습니다.

Issue #224의 통합 RED에서 10개 중 7개가 새 요구 assertion으로 실패하는 것을 확인한 뒤 Green을 구현했습니다. 최종 cold/전체 workspace 검증은 통합 head에서 수행합니다. 이 보강은 이전 Vite 종료 실패의 내부 원인을 해결했다는 근거가 아닙니다.

### 기존 cold import 회귀

기준 `1f2434b033662fd4dd7bf36181f05062398933a2`에서 Web·Desktop test는 App의 `@ldb/ui` import 해석, typecheck와 build는 같은 import의 TS2307로 실패한다. Web dev와 Desktop renderer dev에서도 `/src/App.tsx`가 import-analysis 오류로 HTTP 500을 반환한다. Test harness 설치 실패가 아닌 보고된 consumer integration defect다. Example은 기존 source alias와 TypeScript paths 덕분에 네 경로가 통과한다. 전체 12 case에서 8개의 예상 실패와 4개 통과를 확인한다.

Green `b5ccfbc0dce4743a9a34fff9324ec520a6bd0613`는 Web/Desktop의 여섯 config에 exact alias와 TypeScript paths를 연결한다. Web은 이미 설치된 Node type을 compiler에 명시해 공식 Snippet의 development guard도 검사한다. Package public API·source·CSS·runtime behavior는 변경하지 않는다. Cold regression 12 case가 모두 통과하며 UI/Web/Desktop lint와 library·Example·Web·Desktop build 및 네 artifact/고지 검사가 통과한다. 기존 전체 UI matrix 재사용 근거와 작은 실제 entry smoke는 `docs/reference/ui-validation.md`에 기록한다.
