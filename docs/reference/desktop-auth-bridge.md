---
type: reference
status: active
scope: desktop isolated authentication bridge
last-reviewed: 2026-09-07
---

# Desktop Auth Bridge

승인된 [Desktop auth contract](../rules/desktop-auth.md)의 5 invoke와 1 event를 기존 main AuthCoordinator 및 AuthPresentation에 연결한다. Production main/preload와 capture 연결은 활성화하지 않는다. 실제 API/provider, OS protocol 등록, Keychain·credential file 접근은 이 결과에 포함하지 않는다.

## 구현 위치와 경계

| File | 현재 책임 |
| --- | --- |
| `apps/desktop/src/backend/auth/ipc-handler.ts` | 등록 window·main frame·exact document와 인자 검사, 정제 결과·snapshot event, async reply의 window 재검사와 dispose |
| `apps/desktop/src/preload/common/types/auth.ts` | Core의 public DTO를 type-only로 재사용하고 shared IPC contract에서 feature API를 파생 |
| `apps/desktop/src/preload/common/types/ipc.ts` | getAuthState/beginLogin/cancelLogin/retryAuth/logout의 argument·return type |
| `apps/desktop/src/preload/api/auth.ts` | Feature invoke, raw Electron event를 제거한 listener wrapper와 개별 unsubscribe |
| `apps/desktop/src/frontend/src/auth/useAuthBridge.ts` | 구독 후 조회, runId/revision·연결 수명에 따른 결과 적용, 명령 busy 및 응답 유실 재조회 |
| `apps/desktop/src/frontend/src/auth/AuthBridge.tsx` | 기존 AuthPresentation에 snapshot·intent를 연결하고 초기/실패한 연결의 고정 안내 표시 |

Core lifecycle은 [Desktop auth core](desktop-auth-core.md), 기존 화면은 [Desktop auth UI](desktop-auth-ui.md)를 따른다. Credential type의 runtime import나 renderer가 제출하는 로그인 성공 상태는 없다. `ok:true`는 명령 처리 결과이며 계정 표시는 main snapshot에서만 결정한다.

허용되지 않은 sender는 snapshot 없는 `AUTH_NOT_ALLOWED` rejection이다. Query인 getAuthState의 추가 인자는 `INVALID_AUTH_COMMAND` rejection이고, 4 mutation의 형식 오류는 기존 AuthCommandResult로 반환한다. 정확한 key 검사에는 enumerable 여부와 무관한 own key 전체를 사용한다. Unexpected command exception은 고정 `AUTH_OPERATION_FAILED` 결과로 정제한다.

Renderer는 첫 조회가 완료되기 전 event를 보류하고 조회 결과와 같은 runId의 더 큰 revision을 적용한다. 다른 runId는 이전 구독을 해제한 뒤 새 조회로 기준을 세운다. API 교체 시 저장된 snapshot을 폐기하므로 같은 API 객체를 다시 사용해도 이전 계정이 복구되지 않는다. 명령 reply나 이전 연결의 listener가 더 최신 snapshot을 덮지 않으며, 응답 유실 시 mutation을 다시 보내지 않고 snapshot만 재조회한다. 초기 연결에 실패하면 계정 화면을 만들지 않고 화면을 다시 열도록 안내한다.

## 격리 Electron fixture

`apps/desktop/scripts/auth-bridge-fixture.config.ts`는 production entry와 별개로 main/preload/renderer를 build한다. 기존 presentation-only fixture는 그대로 유지한다.

- `apps/desktop/scripts/auth-bridge-fixture/main.ts`: 임시 profile, sandbox·contextIsolation 활성화, nodeIntegration 비활성화, network/media·navigation/popup 차단과 등록·종료 정리.
- `apps/desktop/scripts/auth-bridge-fixture/effects.ts`: 실제 coordinator에 전달할 memory-only fake HTTP/Store/Browser/Clock/Entropy. Synthetic return target과 canary는 fixture 전용이며 실제 protocol/API 등록값이 아니다. 두 번째 coordinator나 별도 인증 상태 머신을 만들지 않는다.
- `apps/desktop/scripts/auth-bridge-fixture/preload.ts`: 실제 auth feature API 6개만 contextBridge로 노출한다. Fixture 조작용 code/URL/token IPC는 없다.
- `apps/desktop/src/frontend/auth-bridge-fixture/`: 기존 AuthPresentation을 실제 bridge에 연결한 전용 renderer.
- `apps/desktop/scripts/auth-bridge-fixture/smoke.ts`: 실제 UI 버튼·feature preload·IPC를 통한 자동 관측. Unsubscribe 함수는 renderer에만 보관하며 실행 결과로 함수 자체를 반환하지 않는다.

Repository root에서 실행한다.

```sh
pnpm --filter @ldb/desktop auth:fixture:build
pnpm --filter @ldb/desktop auth:fixture:smoke
pnpm --filter @ldb/desktop auth:fixture
```

Build command는 전용 TypeScript 검사 후 Electron Vite build를 수행한다. 실행 entry는 `apps/desktop/out/auth-bridge-fixture/main/main.cjs`다. 고정 window title은 **LDB Auth Bridge fixture**다.

수동 실행에서는 Google/Discord 버튼으로 로그인 대기에 들어가며 자동으로 완료하지 않는다. 현재 화면의 취소 버튼으로 취소하거나, macOS menu의 **Fixture → Complete login**으로 main 내부 synthetic return을 전달한다. Welcome의 시작하기로 home에 들어간 뒤 현재 기기 logout을 확인한다. 창 닫기 또는 **Fixture → Quit**은 앱을 종료하고 임시 profile을 삭제한다. 정상 종료 시 `Auth bridge fixture cleanup PASS`가 출력된다.

자동 smoke는 empty-store start, begin/cancel, event payload의 raw event 제거·canary 비노출, unsubscribe, waiting 상태 reload, credential commit 보류 중 signedIn 비노출, exchange→welcome→home→logout과 fake effect 횟수를 검증한다. `Auth bridge fixture smoke PASS`와 `cleanup PASS`, process exit 0을 함께 확인한다. 실패 진단은 고정 stage와 PASS/FAIL만 출력하며 credential·URL·raw error를 출력하지 않는다. 강제 process 종료나 host crash의 profile 정리는 정상 종료 evidence에 포함하지 않는다.

## 검증 범위와 제한

```sh
pnpm --filter @ldb/desktop exec vitest run src/backend/auth/ipc-handler.test.ts src/preload/api/auth.test.ts src/frontend/src/auth/useAuthBridge.test.tsx
pnpm --filter @ldb/desktop run --sequential '/^(test|lint|build)$/'
git diff --check
```

Unit 경계 검증, 실제 Electron smoke, 수동 UI 확인은 별도 evidence다. Build에는 기존 node/web typecheck가 포함되며 fixture의 전용 TypeScript/build는 별도로 실행한다. 실행한 exact revision·결과와 review는 Issue #116과 해당 PR에서 관리한다.

미결정 restore 종료 정책을 fixture로 선택하거나 새 notice를 만들지 않는다. Fake store는 빈 상태로 시작하며 복원 경로를 제공하지 않는다. 안전한 실제 저장소·protocol·서버/provider·capture 통합과 다른 OS/package 검증은 후속 작업이다. Sandbox fixture 성공으로 production capture/OCR 호환성이나 native 인증 완료를 주장하지 않는다.
