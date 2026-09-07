---
type: reference
status: active
scope: desktop authentication capture integration and isolated media fixture
last-reviewed: 2026-09-07
---

# Desktop Auth Capture

[승인된 Desktop auth 경계](../rules/desktop-auth.md)에 따라 기존 capture 화면을 signedIn home에 연결하고 인증 이탈 시 main source와 renderer resource를 정리한다. 제품 entry에는 실제 auth effects가 아직 구성되지 않았으므로 기본 실행은 고정된 인증 연결 실패 안내를 표시하며 capture를 mount하지 않는다. 실제 로그인·native credential 저장·OS protocol 등록·API/provider 연결 완료를 뜻하지 않는다.

## 구현 위치

| File | 현재 책임 |
| --- | --- |
| `apps/desktop/src/backend/auth/coordinator.ts`, `types.ts` | `captureGeneration(): number \| null`로 현재 signedIn의 내부 auth generation만 반환한다. HTTP용 `authorization()`을 호출하거나 access expiry 때문에 refresh하지 않는다. |
| `apps/desktop/src/backend/capture/ipc-handler.ts` | 실제 coordinator를 등록하고 source 열거·선택·media 완료의 auth/window/document 수명을 확인한다. 선택 무효화, trusted 빈 선택 cleanup, 안정화 통지의 현재 main 권한과 raw log 제거를 담당한다. |
| `apps/desktop/src/backend/renderer-document.ts` | 개발 URL은 HTTP(S)의 exact `localhost`, `127.0.0.1`, `[::1]`과 canonical 입력만 허용한다. Credential·공백·control·backslash·host alias를 거절하고 Electron Vite가 제공하는 slash 없는 bare origin만 정규화한다. |
| `apps/desktop/src/backend/main.ts` | 검증한 renderer URL, sandbox·contextIsolation 활성화, nodeIntegration 비활성화와 navigation/popup 차단을 구성한다. 실제 auth owner를 만들지 않으며 permission check/request도 명시적으로 거절해 legacy media 경로를 차단한다. |
| `apps/desktop/src/preload/index.ts`, `index.d.ts` | 기존 auth/capture feature API만 노출한다. 범용 `window.electron`과 isolation-off fallback은 없다. |
| `apps/desktop/src/frontend/src/App.tsx`, `auth/AuthBridge.tsx`, `auth/AuthPresentation.tsx` | 실제 제품 App이 AuthBridge의 home content로 기존 PartyCapture를 전달한다. Welcome·인증 처리·연결 실패 화면에서는 capture를 mount하지 않는다. |
| `apps/desktop/src/frontend/src/capture/PartyCapture.tsx` | 기존 capture App의 source/interval·Start/Stop·인식값 UI를 재사용한다. 공용 UI 외형을 변경하지 않는다. |
| `apps/desktop/src/frontend/src/capture/usePartyCaptureSession.ts`, `usePartyRecognition.ts`, `useCaptureSourceSelection.ts` | 현재 capture의 AbortSignal을 OCR에 전달하고 종료 뒤 결과·통지를 버린다. Unmount에서 stream·video·worker·loop와 main 선택을 정리한다. |

Capture generation은 main 내부 값이며 snapshot/IPC payload로 추가하지 않는다. Renderer의 revision이나 snapshot은 권한 근거가 아니다. 기존 [auth bridge](desktop-auth-bridge.md)의 구독 순서·snapshot allowlist·credential 비노출을 유지한다. Auth API 오류는 기존 고정 UI로 처리하며 명령을 자동 재전송하지 않는다.

## 권한과 수명

Source 요청의 시작 및 비동기 완료에서 등록 window·sender·main frame·exact document와 현재 auth generation을 검사한다. Media는 기존 video 요청·audio 미요청·user gesture·선택 source 존재 검사도 적용한다. 완료 전에 logout, 선택 해제, navigation 또는 window 변경이 일어나면 이전 stream을 허용하지 않는다.

Renderer는 accepted signedIn 이탈을 별도 presentation epoch로 기록하므로 React가 이탈과 재로그인을 한 render로 합쳐도 이전 capture를 재사용하지 않는다. Main runId가 바뀐 빠른 재연결도 mount key를 바꾸며, 같은 signedIn의 일반 revision 갱신은 capture를 재시작하지 않는다.

Main은 auth 이탈 알림에서 선택을 직접 지우며 trusted renderer의 빈 source 선택은 인증 phase와 무관하게 허용한다. 다른 window/frame/document의 cleanup 요청은 거절한다. 재로그인은 source와 Start를 다시 요구한다. Capture의 이전 AbortSignal이 취소되면 늦은 OCR은 새 instance의 상태를 변경하거나 안정화 통지를 보내지 않는다. IPC 발송 뒤 main 권한이 이탈해 생긴 통지 거절도 raw error log 없이 회수한다.

`notifyStableNicknameDetected`는 현재 main 권한·기존 입력 검사를 통과해도 아직 검색/HTTP를 실행하지 않는다. Raw OCR nickname을 log에 남기지 않으며 이 연결을 인증 검색 완료로 표현하지 않는다. 검색·slot 후보·profile과 [남은 restore/native 정책](desktop-auth-core.md)은 별도 작업이다.

## 격리 Electron fixture

`apps/desktop/scripts/auth-capture-fixture.config.ts`는 production과 별도 output을 사용하면서 실제 제품 `src/preload/index.ts`와 `App`을 build한다. Main은 기존 AuthCoordinator·auth/capture 등록 module 및 auth-only fixture의 memory-only effects를 재사용한다. `auth:fixture`의 media 차단 환경과 별개다.

```sh
pnpm --filter @ldb/desktop capture:fixture:build
pnpm --filter @ldb/desktop capture:fixture:ocr
pnpm --filter @ldb/desktop capture:fixture:smoke
pnpm --filter @ldb/desktop capture:fixture
```

Build는 기존 OCR assets 준비, fixture 전용 TypeScript 검사와 Electron Vite build를 포함한다. Output은 `apps/desktop/out/auth-capture-fixture/`다. 실제 앱 window title은 **LDB Auth Capture fixture**, 입력 창은 **LDB Synthetic Capture Source**다. 후자는 기존 `PARTY_SLOTS`·mana color를 사용한 1920×1080 canvas이며 실제 개인 화면을 입력으로 사용하지 않는다.

수동 실행은 Google/Discord 버튼→앱 메뉴의 **Complete login**→**시작하기**→source 목록의 **LDB Synthetic Capture Source**→**Start** 순서다. 로그아웃 후 인식값과 capture UI가 사라지는지, 재로그인 뒤 source와 Start가 다시 필요한지 확인한다. 앱 메뉴의 **Quit LDB Auth Capture fixture**로 종료하면 임시 profile 삭제 여부를 출력한다. 기존 다른 Electron instance를 종료하지 않는다.

통합 smoke는 실제 버튼·feature preload·main IPC·media·OCR를 검증하도록 구성됐지만, 현재 아래 native permission 경계 때문에 media 단계에서 통과하지 못한다. 별도 renderer 관측 wrapper는 native `getDisplayMedia`, Worker 생성/종료와 track stop을 그대로 호출하고 횟수·종료 상태만 수집한다. MediaStream이나 OCR 결과를 test double로 대체하지 않는다. 성공 판정에는 실제 stream, worker 초기화, synthetic nickname의 안정화 표시, logout 뒤 track/worker/video 정리와 재로그인 시 자동 capture 0이 필요하다. Raw nickname·credential·URL을 진단 출력으로 반환하지 않는다.

Fixture constructor는 `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`를 고정한다. Product와 fixture의 preload는 동일 source의 CJS bundle이며 byte 동등성을 비교할 수 있다. Fixture의 `.cjs` 이름은 output 격리용이며 sandbox에서 다른 구현을 사용하는 우회가 아니다. CSP는 제품 entry와 같은 경계를 사용하고 webSecurity를 끄지 않는다. Network·native credential·provider·OS protocol은 사용하지 않는다.

## Native media와 독립 OCR의 관측 구분

Pinned Electron 39.8.10의 [permission 처리 source](https://raw.githubusercontent.com/electron/electron/v39.8.10/shell/browser/web_contents_permission_helper.cc)는 `getDisplayMedia`와 legacy desktop `getUserMedia`를 모두 `media` permission 및 빈 `mediaTypes`로 전달한다. 이 빈 배열만 허용하면 legacy 경로가 display handler의 source·gesture 검사를 우회할 수 있다. 허용 경계를 확정하기 전까지 제품 기본 entry와 현재 fixture는 permission check/request를 모두 거절한다. Renderer API monkey patch나 CSP/webSecurity 완화로 이 차이를 숨기지 않는다.

첫 native 관측에서 auth·sandbox·synthetic source 열거/선택은 진행됐고 host screen permission은 `granted`였다. Native media 요청은 `NotAllowedError`, 실제 stream 0·worker 0으로 종료됐으며 profile cleanup은 확인했다. OS 권한이 있다는 사실을 앱의 capture 경계 검증 완료로 해석하지 않는다. `capture:fixture:smoke`의 통합 media 성공은 현재 미완료다.

`capture:fixture:ocr`는 별도 검증이다. 같은 sandbox와 실제 제품 preload를 사용하되 `createPartyOcrWorker`에 synthetic canvas를 직접 전달한다. 실제 Korean/English asset·WASM·Worker 인식 결과의 예상값 일치와 생성 1·terminate 1을 확인했으며 media 요청·stream은 각각 0이다. Raw 인식 문자열은 반환하거나 log하지 않는다. 이 PASS는 native window capture나 통합 capture cleanup을 대체하지 않는다. Stream·loop·late OCR의 제품 수명 경합은 unit/hook doubles의 evidence와 구분한다.

## 검증과 제한

```sh
pnpm --filter @ldb/desktop exec vitest run src/backend/capture src/backend/main.test.ts src/frontend/src/auth src/frontend/src/capture src/frontend/src/App.test.tsx src/frontend/src/App.capture-controls.test.tsx
pnpm --filter @ldb/desktop run --sequential '/^(test|lint|build)$/'
git diff --check
```

Unit/hook 검증은 실제 core와 테스트용 effects 또는 stream/worker doubles를 사용한 경합 evidence다. 실제 Electron media/OCR 관측과 구분하며 실행한 commit·command·결과는 Issue #126과 PR에 기록한다. Build에는 기존 node/web typecheck가 포함된다. 최종 integration head의 전체 validation과 독립 review는 Worker 결과와 별도다.

실제 native 인증의 Keychain·file durability·protocol association·provider 등록, 다른 OS/arch/package는 이 fixture로 검증되지 않는다. 남은 지원·배포 gate는 [Desktop auth platform](../rules/desktop-auth-platform.md)을 따른다. Auth-only fixture나 mocked OCR의 PASS로 실제 media/OCR 실패를 대체하지 않는다.
