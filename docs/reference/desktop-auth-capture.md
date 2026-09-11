---
type: reference
status: active
scope: desktop authentication capture integration and isolated media fixture
last-reviewed: 2026-09-11
---

# Desktop Auth Capture

[승인된 Desktop auth 경계](../rules/desktop-auth.md)에 따라 기존 capture 화면을 signedIn home에 연결하고 인증 이탈 시 main source와 renderer resource를 정리한다. 제품 entry는 trusted auth 설정이 없을 때 고정된 인증 연결 실패 안내를 표시하며 capture를 mount하지 않는다. 설정이 유효할 때만 main auth generation과 검색 HTTP를 capture IPC에 연결한다. 실제 로그인·native credential 저장·OS protocol registry·API/provider 연결 완료를 뜻하지 않는다.

## 구현 위치

| File                                                                                                                        | 현재 책임                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/backend/auth/coordinator.ts`, `types.ts`                                                                  | `captureGeneration(): number \| null`로 현재 signedIn의 내부 auth generation만 반환한다. HTTP용 `authorization()`을 호출하거나 access expiry 때문에 refresh하지 않는다.                                         |
| `apps/desktop/src/backend/capture/ipc-handler.ts`                                                                           | 실제 coordinator를 등록하고 source 열거·선택·media 완료의 auth/window/document 수명을 확인한다. 선택 무효화, trusted 빈 선택 cleanup, 안정화 통지의 현재 main 권한과 raw log 제거를 담당한다.                   |
| `apps/desktop/src/backend/renderer-document.ts`                                                                             | 개발 URL은 HTTP(S)의 exact `localhost`, `127.0.0.1`, `[::1]`과 canonical 입력만 허용한다. Credential·공백·control·backslash·host alias를 거절하고 Electron Vite가 제공하는 slash 없는 bare origin만 정규화한다. |
| `apps/desktop/src/backend/main.ts`                                                                                          | 검증한 renderer URL, sandbox·contextIsolation 활성화, nodeIntegration 비활성화와 navigation/popup 차단을 구성한다. Trusted auth runtime을 만들 때만 coordinator, auth/capture IPC와 exact document를 연결한다.  |
| `apps/desktop/src/backend/capture/permission-policy.ts`                                                                     | 기존 승인 경계대로 default session의 permission check는 false로 유지하고, 등록 window·main frame·현재/요청 exact document·signed-in generation·media와 빈 `mediaTypes`만 request에서 허용한다.                  |
| `apps/desktop/src/preload/index.ts`, `index.d.ts`                                                                           | auth/capture와 검색 feature API만 노출한다. 범용 `window.electron`과 isolation-off fallback은 없다.                                                                                                             |
| `apps/desktop/src/frontend/src/App.tsx`, `auth/AuthBridge.tsx`, `auth/AuthPresentation.tsx`                                 | 실제 제품 App이 AuthBridge의 home content로 기존 PartyCapture를 전달한다. Welcome·인증 처리·연결 실패 화면에서는 capture를 mount하지 않는다.                                                                    |
| `apps/desktop/src/frontend/src/capture/PartyCapture.tsx`                                                                    | 기존 source/interval·Start/Stop·인식값 UI와 네 슬롯 검색 결과를 표시한다. 공용 UI 외형을 변경하지 않는다.                                                                                                       |
| `apps/desktop/src/frontend/src/capture/usePartyCaptureSession.ts`, `usePartyRecognition.ts`, `useCaptureSourceSelection.ts` | 현재 capture의 AbortSignal을 OCR에 전달하고 종료 뒤 결과·통지를 버린다. Unmount에서 stream·video·worker·loop와 main 선택을 정리한다.                                                                            |

Capture generation은 main 내부 값이며 snapshot/IPC payload로 추가하지 않는다. Renderer의 revision이나 snapshot은 권한 근거가 아니다. 기존 [auth bridge](desktop-auth-bridge.md)의 구독 순서·snapshot allowlist·credential 비노출을 유지한다. Auth API 오류는 기존 고정 UI로 처리하며 명령을 자동 재전송하지 않는다.

## 권한과 수명

Source 요청의 시작 및 비동기 완료에서 등록 window·sender·main frame·exact document와 현재 auth generation을 검사한다. Media는 기존 video 요청·audio 미요청·user gesture·선택 source 존재 검사도 적용한다. 완료 전에 logout, 선택 해제, navigation 또는 window 변경이 일어나면 이전 stream을 허용하지 않는다.

Renderer는 accepted signedIn 이탈을 별도 presentation epoch로 기록하므로 React가 이탈과 재로그인을 한 render로 합쳐도 이전 capture를 재사용하지 않는다. Main runId가 바뀐 빠른 재연결도 mount key를 바꾸며, 같은 signedIn의 일반 revision 갱신은 capture를 재시작하지 않는다.

Main은 auth 이탈 알림에서 선택을 직접 지우며 trusted renderer의 빈 source 선택은 인증 phase와 무관하게 허용한다. 다른 window/frame/document의 cleanup 요청은 거절한다. 재로그인은 source와 Start를 다시 요구한다. Capture의 이전 AbortSignal이 취소되면 늦은 OCR은 새 instance의 상태를 변경하거나 안정화 통지를 보내지 않는다. IPC 발송 뒤 main 권한이 이탈해 생긴 통지 거절도 raw error log 없이 회수한다.

`notifyStableNicknameDetected`는 captureId·slot·observationRevision·nickname을 받아 현재 수명의 검색으로 연결한다. Main의 HTTP/전체 응답 검증과 renderer의 네 슬롯 후보·retry 구현은 [캐릭터 검색](desktop-character-search.md)을 참고한다. Raw OCR nickname은 log에 남기지 않는다. Profile과 [남은 restore/native 정책](desktop-auth-core.md)은 별도 작업이다.

## 격리 Electron fixture

`apps/desktop/scripts/auth-capture-fixture.config.ts`는 production과 별도 output을 사용하면서 실제 제품 `src/preload/index.ts`와 `App`을 build한다. Main은 기존 AuthCoordinator·auth/capture 등록 module 및 auth-only fixture의 memory-only effects를 재사용한다. `auth:fixture`의 media 차단 환경과 별개다.

```sh
pnpm --filter @ldb/desktop capture:fixture:build
pnpm --filter @ldb/desktop capture:fixture:ocr
pnpm --filter @ldb/desktop capture:fixture:smoke
pnpm --filter @ldb/desktop capture:fixture:deny
pnpm --filter @ldb/desktop capture:fixture
```

Build는 기존 OCR assets 준비, fixture 전용 TypeScript 검사와 Electron Vite build를 포함한다. Output은 `apps/desktop/out/auth-capture-fixture/`다. 실제 앱 window title은 **LDB Auth Capture fixture**, 입력 창은 **LDB Synthetic Capture Source**다. 후자는 기존 `PARTY_SLOTS`·mana color를 사용한 1920×1080 canvas이며 실제 개인 화면을 입력으로 사용하지 않는다.

수동 실행은 Google/Discord 버튼→앱 메뉴의 **Complete login**→**시작하기**→source 목록의 **LDB Synthetic Capture Source**→**Start** 순서다. 로그아웃 후 인식값과 capture UI가 사라지는지, 재로그인 뒤 source와 Start가 다시 필요한지 확인한다. 앱 메뉴의 **Quit LDB Auth Capture fixture**로 child를 종료하면 Node launcher가 process group 종료와 profile 최종 삭제를 확인한다. 삭제 또는 삭제 확인에 실패하면 고정된 cleanup FAIL과 exit 1로 종료하며 raw filesystem 오류를 출력하지 않는다. 기존 다른 Electron instance를 종료하지 않는다.

통합 smoke는 실제 버튼·feature preload·main IPC·media·OCR를 검증한다. Renderer 관측 wrapper는 native `getDisplayMedia`, Worker 생성/종료·OCR 요청, video와 track stop을 그대로 호출한다. Main 관측 wrapper도 실제 제품 display/안정화 통지 handler를 그대로 호출하고 counter와 slot별 합성 기대값 일치 bitmask만 수집한다. 원문 통지 payload나 nickname은 보관하지 않는다. MediaStream이나 OCR 결과를 test double로 대체하지 않는다. 실제 video에서 제품 crop 함수를 호출해 기존 frame 크기와 네 slot mana 영역 일치를 확인하고 native track 크기는 별도로 기록한다. 성공 판정에는 실제 stream과 worker 초기화, 네 slot 각각의 정확한 synthetic 표시값과 실제 main handler 통과 뒤 기대값 통지가 모두 필요하다. 통지 접수는 `ok:true`와 응답 snapshot의 capture/slot/nickname/observationRevision이 입력과 정확히 일치하는 경우만 센다. 더 오래되거나 새로운 관측의 snapshot과 정상 resolve된 거절은 접수 증거가 아니다. 표시와 통지의 bitmask가 각각 `15`여야 하며 crop/mana 존재나 같은 slot의 중복 통지로 이를 대체하지 않는다. Logout 뒤 track/worker/video 정리와 재로그인 시 자동 capture 0도 확인한다. Raw nickname·credential·URL을 진단 출력으로 반환하지 않는다.

Fixture constructor는 `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`를 고정한다. Product와 fixture의 preload는 동일 source의 CJS bundle이며 byte 동등성을 비교할 수 있다. Fixture의 `.cjs` 이름은 output 격리용이며 sandbox에서 다른 구현을 사용하는 우회가 아니다. CSP는 제품 entry와 같은 경계를 사용하고 webSecurity를 끄지 않는다. 실제 network·native credential·provider·OS protocol은 사용하지 않는다. 검색도 main에 주입한 고정 합성 transport만 사용하며 응답별 수동 확인 방법은 [검색 fixture 절차](desktop-character-search.md#격리-미디어와-화면-검증)를 따른다.

## 실제 UI 관측

권한 예외 승인 전 통합 head `7dd3b40a`에서 fixture build 후 macOS의 1100×800 dark UI를 CUA로 확인했다. SignedOut에는 capture가 없고 Google 대기→메뉴 Complete login→welcome에서도 capture가 없었다. 시작하기 뒤 기존 capture home에서 synthetic source를 선택하면 Start가 활성화됐다. Start는 당시 명시 차단에 따라 `Permission denied`를 표시했다. Logout 뒤 capture와 해당 안내가 사라졌고, 재로그인 welcome/home에는 빈 source와 비활성 Start가 표시됐다. Quit 메뉴 뒤 command exit 0·child의 cleanup PASS·process 종료를 관측했다. 당시 cleanup PASS는 quit event 안의 검사였으며 종료 뒤 profile 부재를 증명하지 못했다. 이 관측은 실제 stream/OCR 통합 성공이 아니다.

수정 후 runtime/build 및 parent head `cf0c564`에서 macOS dark UI를 수동으로 다시 확인했다. SignedOut와 welcome에는 capture가 없고 home의 source는 비어 있으며 Start가 비활성이었다. 고정된 **LDB Synthetic Capture Source**를 선택하고 Start를 누르자 1920×1080 준비 상태와 네 slot의 실제 OCR 합성 기대값 일치를 확인했다. Capture 중 logout 뒤 capture와 인식값이 사라졌고, 재로그인 welcome/home에서도 빈 source와 비활성 Start를 확인했다. 같은 synthetic source를 다시 선택하고 새 Start를 눌러 두 번째 1920×1080 capture와 네 slot의 실제 OCR 기대값 일치를 확인한 뒤 logout으로 제거하고 Quit 메뉴로 종료했다. 이는 아래 초기 자동 실행에서 미관측으로 남긴 재선택 후 두 번째 capture를 후속 수동 실행으로 확인한 기록이다. 메뉴 자동화의 오래된 접근성 참조는 현재 상태를 다시 조회해 해결했으며 제품 결함은 아니었다. Command exit 0과 launcher cleanup PASS, 고정된 video 누락 TypeError 및 `UnhandledPromiseRejectionWarning` 부재를 확인했다. 최종 통합 head의 전체 validation과 최종 profile 부재 검사는 별도다.

## Native media와 독립 OCR의 관측 구분

Pinned Electron 39.8.10의 [permission 처리 source](https://raw.githubusercontent.com/electron/electron/v39.8.10/shell/browser/web_contents_permission_helper.cc)는 `getDisplayMedia`와 legacy desktop `getUserMedia`를 모두 `media` permission 및 빈 `mediaTypes`로 전달한다. 이 빈 배열만 허용하면 legacy 경로가 display handler의 source·gesture 검사를 우회할 수 있다. [승인된 media 검증 예외](../rules/desktop-capture-media-fixture-proposal.md)는 통제된 fixture만 신뢰한다. `permissions.ts`와 제품 `capture/permission-policy.ts`는 살아 있는 등록 창의 정확한 main frame·현재/요청 document와 main signedIn을 확인한 뒤 `media`의 존재하는 빈 `mediaTypes` 배열만 허용한다. 두 정책 모두 permission check는 false로 두고 request 단계에서만 이 좁은 예외를 판정한다. `capture:fixture:deny`는 fixture request도 전면 거절하는 회귀 검증 모드다. Renderer API monkey patch를 legacy 경로 차단 보장으로 해석하거나 CSP/webSecurity를 완화하지 않는다.

첫 native 관측에서 auth·sandbox·synthetic source 열거/선택은 진행됐고 host screen permission은 `granted`였다. Native media 요청은 `NotAllowedError`, 실제 stream 0·worker 0으로 종료됐다. 당시 child의 cleanup PASS 이후 초기 실패 실행의 profile 두 개가 남은 것을 확인했으므로 이전 cleanup 성공 판정은 철회했다. OS 권한이 있다는 사실을 앱의 capture 경계 검증 완료로 해석하지 않는다. 이 기록은 승인 전 실패이며 아래 승인 후 관측과 구분한다.

승인 후 입력 `cdfabca05111724d7c408abfd5d9c55139af0a40`에서 macOS 26.6.2 arm64·Electron 39.8.10으로 `capture:fixture:smoke`를 실행해 exit 0을 관측했다. 실제 제품 display handler 요청 1·허용 1, 실제 stream 1·worker 1, native track와 실제 video frame 모두 1920×1080·네 slot의 mana/crop 존재, Slot 1의 실제 OCR 기대값 표시와 main 안정화 통지 1회 이상을 확인했다. 당시 자동 검증은 Slot 2–4의 표시나 slot별 통지 기대값을 검사하지 않았으므로 네 slot OCR/IPC 완료 evidence로 해석하지 않는다. Logout 뒤 track 종료·worker terminate·video 해제는 각각 1이며 인식값과 capture UI가 사라졌다. 이어진 3.2초 동안 OCR 요청과 main 안정화 IPC가 증가하지 않았다. 재로그인 뒤 source는 비어 있고 Start는 비활성이며 자동 stream/worker 생성은 0이었다. Source를 다시 고르지 않은 실제 media 요청은 main display handler까지 도달해 거절돼 누적 요청 2·허용 1이었다. 새 source 선택 후 두 번째 capture 성공은 이 실행에서 관측하지 않았다. 강제로 지연시킨 이전 OCR 완료 경합은 별도 unit/hook evidence다.

이 실행에서 무선택 요청 거절 callback은 Electron의 `Video was requested, but no video stream was provided` unhandled rejection warning을 남겼으나 renderer의 media promise는 거절됐다. 마지막 logout과 진행 중 source 열거가 경합해 main의 `Capture source access denied`도 출력됐다. 이 출력은 숨기지 않으며 경고 없는 실행이라고 주장하지 않는다. Launcher의 cleanup PASS와 exit 0은 확인했지만 별도 종료 후 검증의 결과는 해당 exact head와 함께 따로 기록한다.

이후 독립 review에서 빈 객체 거절이 실제 Electron API 형식 결함임을 확인해 보완했다. Pinned [native 결과 처리](https://raw.githubusercontent.com/electron/electron/v39.8.10/shell/browser/electron_browser_context.cc)는 `null`에 예외 없는 `CAPTURE_FAILURE`를 반환한다. 제품의 `deliverMediaResult`는 공개 `Streams` type에 없는 이 native 거절을 좁은 interop로 전달하고, 이미 소비됐을 수 있는 callback의 예외를 source 열거 실패와 분리해 재호출하지 않는다. 기존 `{}` 기대 test는 거절 의미를 유지하면서 실제 runtime 형식에 맞게 정정했고 fixture 관측도 `null`을 그대로 전달한다.

수정 후 입력 `cf0c5640988aa0faf67578211f9bac969e15435b`에서 같은 OS/Electron의 `post-exit-check.mjs --media`를 한 번 실행했다. 당시 자동 검증 범위인 실제 stream·Slot 1 OCR 표시·안정화 통지 1회 이상, logout 정리·재로그인 무선택 거절과 child exit 0·process group 종료·종료 뒤 profile 0개가 PASS했다. 위 수동 관측의 네 slot 표시와 두 번째 capture는 이 자동 검증과 별도 evidence다. Check는 고정된 video 누락 TypeError와 `UnhandledPromiseRejectionWarning`이 child 출력에 없음을 별도로 확인했다. Source 열거의 정상 auth 거절 출력은 이 경고 회귀로 분류하지 않는다.

[PR #142의 검토 지적](https://github.com/blahaj94/ldb/pull/142#discussion_r3954191493)을 반영한 입력 `6cc70e03d529342a6b5f24f70a63055d906aa983`에서 같은 macOS 26.6.2 arm64·Electron 39.8.10으로 강화된 `post-exit-check.mjs --media`를 한 번 실행했다. 네 slot의 정확한 실제 OCR 표시 bitmask `15`와 실제 main handler 통과 뒤 각 slot 기대값 통지 bitmask `15`를 함께 확인했다. 실제 media/OCR smoke와 child exit 0·process group 종료·native 거절 경고 0·종료 뒤 profile 0개가 PASS했다. Slot 누락·오인식·중복 통지나 표시/통지 한쪽만 일치하면 성공할 수 없는 회귀 검증도 추가했다. 이 실행은 기존 수동 재로그인·재선택 후 두 번째 capture 관측을 대체하거나 반복한 것이 아니다.

`capture:fixture:ocr`는 별도 검증이다. 같은 sandbox와 실제 제품 preload를 사용하되 `createPartyOcrWorker`에 synthetic canvas를 직접 전달한다. 실제 Korean/English asset·WASM·Worker 인식 결과의 예상값 일치와 생성 1·terminate 1을 확인했으며 media 요청·stream은 각각 0이다. Raw 인식 문자열은 반환하거나 log하지 않는다. 이 PASS는 native window capture나 통합 capture cleanup을 대체하지 않는다. Stream·loop·late OCR의 제품 수명 경합은 unit/hook doubles의 evidence와 구분한다.

## 종료 후 profile 정리

공식 `capture:fixture`, `capture:fixture:smoke`, `capture:fixture:deny`, `capture:fixture:ocr`는 `apps/desktop/scripts/auth-capture-fixture.mjs`의 Node launcher를 사용한다. Launcher는 새 임시 profile과 로컬 `owner.json`을 만들고 Electron child에 profile·parent PID를 전달한다. Child는 이 시작 조건이 없으면 profile 사용 전에 거절하며, `out/auth-capture-fixture/main/main.cjs`의 직접 실행은 공식 실행 방법이 아니다. 최종 삭제 책임을 child의 quit event에 두지 않는다.

Launcher는 child 완료 후 자신이 만든 POSIX process group의 종료를 확인하고 profile을 삭제한 뒤 `lstat`의 부재 결과를 검사한다. Timeout·중단에도 소유 group만 종료하며 group 종료가 미확인이면 profile 삭제와 성공 판정을 하지 않는다. SIGINT/SIGTERM handler는 profile 생성 전부터 최종 삭제·부재 확인까지 유지한다. 준비 중 신호는 child 생성을 막고, cleanup 중 반복 신호는 정리를 계속하면서 최종 결과만 nonzero로 바꾼다. 정리 중 신호 때문에 이미 종료된 group에 추가 signal을 보내지 않는다. 삭제·부재 확인 오류는 정제된 실패와 nonzero 종료다. 이 launcher의 실제 검증 환경은 macOS이며 Windows process-group 실행은 허용하지 않는다. 다른 platform 성공을 주장하지 않는다.

`c36159a`의 실제 격리 검증에서 deny-all smoke는 child exit 1·group 종료 확인·종료 뒤 profile 0개였고, 정상 OCR은 child exit 0·group 종료 확인·종료 뒤 profile 0개였다. 검증용 TMPDIR도 해당 child/group 종료 뒤 정리했다. 승인 후에도 native 입력 `cdfabca0`와 `143c510`의 post-exit wrapper로 명시적 `capture:fixture:deny`를 실행해 child exit 1·group 종료·종료 뒤 profile 0개와 post-exit check PASS를 확인했다. 별도로 생성 시각·예상 directory 내용·열린 file 부재로 식별한 초기 실패 profile 두 개만 삭제하고 부재를 확인했다. 다른 Electron/profile·credential-store 자원은 정리 대상으로 사용하지 않았다.

```sh
node apps/desktop/scripts/auth-capture-fixture/post-exit-check.mjs
node apps/desktop/scripts/auth-capture-fixture/post-exit-check.mjs --ocr
node apps/desktop/scripts/auth-capture-fixture/post-exit-check.mjs --media
```

첫 command는 `capture:fixture:deny`의 의도된 media 차단 exit 1 뒤 cleanup을 검증하므로 check PASS가 media PASS를 뜻하지 않는다. `--ocr`는 실제 OCR 단독 성공과 종료 뒤 정리를 확인하며, `--media`는 실제 stream/OCR smoke exit 0, native 거절 경고 부재와 종료 뒤 정리를 요구한다. Post-exit check의 바깥 제한은 150초로 fixture 90초·launcher 120초와 후속 정리 시간을 포함한다. 가짜 child가 125초에 정상 완료할 때 조기 종료되지 않는 회귀 검증으로 이전 60초 제한 문제를 재현·보완했다. 제품 HTTP timeout은 바꾸지 않는다. 일반 Vitest는 native process를 시작하지 않으며 launcher의 삭제/확인 실패·child 실패·group 종료 미확인과 직접 child 거절을 mocks로 검증한다.

## 검증과 제한

```sh
pnpm --filter @ldb/desktop exec vitest run scripts/auth-capture-fixture src/backend/capture src/backend/main.test.ts src/frontend/src/auth src/frontend/src/capture src/frontend/src/App.test.tsx src/frontend/src/App.capture-controls.test.tsx
pnpm --filter @ldb/desktop run --sequential '/^(test|lint|build)$/'
git diff --check
```

Unit/hook 검증은 실제 core와 테스트용 effects 또는 stream/worker doubles를 사용한 경합 evidence다. 실제 Electron media/OCR 관측과 구분하며 실행한 commit·command·결과는 Issue #126과 PR에 기록한다. Build에는 기존 node/web typecheck가 포함된다. 최종 integration head의 전체 validation과 독립 review는 Worker 결과와 별도다.

실제 native 인증의 Keychain·file durability·protocol association·provider 등록, 다른 OS/arch/package는 이 fixture로 검증되지 않는다. 남은 지원·배포 gate는 [Desktop auth platform](../rules/desktop-auth-platform.md)을 따른다. Auth-only fixture나 mocked OCR의 PASS로 실제 media/OCR 실패를 대체하지 않는다.
