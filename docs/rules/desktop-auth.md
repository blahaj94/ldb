---
type: rule
status: proposed
enforcement: approval-required
scope: apps/desktop authentication process IPC and screens
last-reviewed: 2026-09-06
rationale: renderer가 credential이나 인증 성공을 소유하지 않고 후속 구현자가 process 경계를 추측하지 않도록 한다.
evidence: "Issue #55; 서버 기반 PR #48 승인, PR #53 merge"
exceptions: 설계 제출만 허용됐으며 제품 구현·실제 OAuth 및 OS 등록·credential 저장소 변경은 포함하지 않는다.
review-after: 최초 Desktop 인증 구현 및 packaged platform validation 시
---

# Desktop Authentication Contract — 승인 대기

이 문서와 [lifecycle](desktop-auth-lifecycle.md), [platform·저장·검증](desktop-auth-platform.md)은 하나의 Desktop Rule 제안이다. Draft PR의 명시적인 사용자 `승인` 전에는 implementation authority가 아니다. 승인은 실제 OS/배포 검증 성공이나 후속 구현 착수 지시를 대체하지 않는다. 기존 [architecture](../architecture/overview.md)의 Desktop 미결정 gate는 승인 전까지 유지한다.

서버의 [API](auth-api.md), [OAuth](auth-oauth.md), [session](auth-session.md), [활동](auth-activity.md), [runtime gate](auth-runtime.md)를 전제로 한다. Endpoint, TTL, JWT/refresh/session 정책, provider 설정과 DB를 변경하지 않는다. `clientId:"desktop"`은 public 등록 선택값이다. 실제 운영 URL·app identity·protocol 값은 platform 문서의 미확인 gate다.

## Process 책임과 권한

| Process | 소유 상태·권한 | 다른 process로 전달하는 것 |
| --- | --- | --- |
| main | 단일 AuthCoordinator, pending login·PKCE, token·user, session generation, HTTP/refresh single-flight, safeStorage/file, protocol event, 고정 설정 기반 browser 열기 | 아래 AuthSnapshot과 정제된 명령 결과만 |
| preload | 허용된 feature별 IPC invoker·event wrapper, listener 수명 | 직렬화 가능한 snapshot DTO. Credential, HTTP, 저장·로그인 상태 판단을 소유하지 않음 |
| renderer | snapshot 복사본, 버튼/화면 상태, welcome 닫힘·capture UI·OCR resource | provider 선택·현재 attempt 취소·복구/로그아웃 의도. 로그인 성공·권한·URL·token을 제출하지 않음 |
| 외부 browser / API | provider 화면·cookie·state·callback 및 code 발급은 기존 서버 계약 | 브라우저 완료는 API 검증 완료일 뿐이며 앱의 로그인 성공은 아님 |

Main은 OS 사용자·app profile당 현재 계정/session 하나만 활성화한다. 계정 전환은 현재 기기 logout 후 새 로그인이다. 다른 앱 설치나 다른 기기는 별개 session이며 Desktop이 한꺼번에 폐기하지 않는다. Main memory 자체가 침해된 경우까지 credential 보호를 보장하지 않는다.

인증이 유효한지는 main 상태와 서버 응답으로 결정한다. Renderer의 route, React state, 임의로 만든 snapshot, `isNewUser`는 권한 증거가 아니다. Token은 renderer storage, browser cookie, IndexedDB, React state, IPC, URL, log에 넣지 않는다. 인증된 HTTP는 main의 고정 endpoint별 기능에서 수행하며 범용 `fetch(url,options)` IPC를 만들지 않는다.

## 기존 구조와 연결

2026-09-06, main `a82547c`에서 source/config를 읽어 확인한 내용이다. 실행 성공 evidence는 아니다.

- `apps/desktop/src/backend/main.ts`는 window/lifecycle composition root이며 capture 등록과 `loadURL`/`loadFile`을 담당한다. Auth/protocol/single-instance/store는 없다. 현재 `sandbox:false`와 임의 popup URL의 `shell.openExternal` 경로가 있다.
- `apps/desktop/src/backend/ipc.ts`, `apps/desktop/src/preload/ipc.ts`, `apps/desktop/src/preload/common/types/ipc.ts`는 `AsyncIPCFunctions`로 handler/invoker type을 연결한다. Runtime validation은 feature handler가 담당한다.
- `apps/desktop/src/backend/capture/ipc-handler.ts`는 등록 window의 `webContents`를 검사하고, display-media는 main frame·선택 source·user gesture 등도 검사한다. 안정화 OCR 문자열은 현재 log까지만 전달하며 HTTP 검색은 없다.
- `apps/desktop/src/frontend/src/App.tsx`는 capture 화면 하나다. `usePartyCapture`, `usePartyCaptureSession`, `usePartyRecognition`은 선택·stream/worker·OCR 안정화 책임을 나누고 unmount 시 capture resource를 정리한다. 계정 화면·검색 후보 화면은 없다.
- `apps/desktop/src/preload/index.ts`는 feature API 외 toolkit `electronAPI`와 context isolation이 꺼진 fallback도 노출한다. `apps/desktop/src/frontend/index.html`은 local CSP를 가진다.

후속 구현의 feature 위치는 `apps/desktop/src/backend/auth/**`, `apps/desktop/src/preload/api/auth.ts`, `apps/desktop/src/preload/common/types/auth.ts`, `apps/desktop/src/frontend/src/auth/**`를 권장한다. Shared IPC contract에는 아래 명령 type을 추가하고 backend/preload는 거기서 파생한다. `main.ts`/preload `index.ts`에는 생성·등록·노출만 둔다. 새 package나 dependency, 범용 service framework는 필요하지 않다.

인증 경계를 연결할 때 `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`를 명시하고 isolation-off fallback·범용 `window.electron` 노출을 제거한다. 기존 capture 전용 API는 유지한다. Renderer navigation/새 window는 차단하고 외부 browser 열기는 검증한 로그인 launch 전용 main 경로로만 허용한다. OAuth 화면을 BrowserWindow/webview에 넣거나 인증을 위해 CSP/webSecurity를 완화하지 않는다. Preload bundle·OCR worker·capture가 sandbox에서 작동하는지는 후속 회귀 검증 대상이며 검증 전 현재 기능과의 호환성을 주장하지 않는다. 이 항목은 현재 구현 설명이 아닌 승인 대상 변경안이다. [Electron security 근거](https://www.electronjs.org/docs/latest/tutorial/security)

## 최소 IPC 계약

기존 feature naming에 맞춘 다음 5개 invoke와 1개 event만 추가한다. `getAuthState`는 local 조회이며 HTTP·활동 갱신을 일으키지 않는다.

| Channel / preload API | 정확한 입력 | 결과와 의미 |
| --- | --- | --- |
| `getAuthState` | 인자 0개 | `AuthSnapshot` |
| `beginLogin` | object 1개 `{provider:"google"\|"discord"}` | `AuthCommandResult`. signedOut에서만 새 attempt 시작. 중복 클릭/다른 provider 입력은 `AUTH_BUSY`, 현재 attempt 유지 |
| `cancelLogin` | object 1개 `{attemptId:string}` | `AuthCommandResult`. 현재 시작/대기/exchange attempt만 취소. 오래된 attempt는 `STALE_ATTEMPT`, 다른 attempt에 영향 없음 |
| `retryAuth` | 인자 0개 | `AuthCommandResult`. restorePaused에서는 안전한 복원 단계만 재개, storageBlocked에서는 local 저장 진단·정리 재시도. 새 browser login·불명확한 code/refresh 재전송은 수행하지 않음 |
| `logout` | 인자 0개 | `AuthCommandResult`. main이 현재 credential을 선택한다. signedOut이면 no-op, 진행 중 logout이면 같은 결과 공유. 그 밖의 경합은 lifecycle을 따름 |
| `authStateChanged` / `onAuthStateChanged(listener)` | main→등록 renderer DTO. preload 함수 입력은 callback 하나 | unsubscribe 함수 반환. Electron event·sender·내부 error를 listener에 넘기지 않음 |

`AuthCommandResult = {ok:true,snapshot:AuthSnapshot} | {ok:false,error:{code:AuthCommandError},snapshot:AuthSnapshot}`다. `AuthCommandError`는 `INVALID_AUTH_COMMAND`, `AUTH_NOT_ALLOWED`, `AUTH_BUSY`, `STALE_ATTEMPT`, `AUTH_OPERATION_FAILED`만 허용한다. 뒤의 두 실행 결과와 상세 UI 안내는 snapshot을 함께 사용한다. 허용되지 않은 sender에는 snapshot 없이 정제된 `AUTH_NOT_ALLOWED` rejection만 반환한다. Raw exception/stack/server message를 반환하지 않는다. `ok:true`는 명령이 처리됐다는 뜻이며 로그인/서버 logout 성공은 snapshot으로만 판단한다.

`beginLogin`은 main에 attempt를 만들고 `startingLogin` snapshot을 반환한다. Browser/HTTP 진행은 event로 받는다. `cancelLogin`은 로컬 무효화, `logout`은 정리 종료 또는 명시적 실패 뒤 결과를 반환한다. IPC 응답 유실 시 같은 명령을 자동 재전송하지 않고 `getAuthState`로 재동기화한다. Renderer 측 bridge 연결 실패는 별도 고정 문구로 표시하며 임의 signedIn을 만들지 않는다.

AuthSnapshot의 전체 allowlist는 다음과 같다. Optional 임의 field를 통과시키지 않는다.

| Field | 값·노출 조건 |
| --- | --- |
| `runId`, `revision` | main 실행마다 새 비민감 random ID, snapshot 전이마다 증가하는 nonnegative safe integer. 서버 request/session ID와 별개 |
| `phase` | `signedOut`, `startingLogin`, `waitingBrowser`, `exchanging`, `restoring`, `restorePaused`, `signedIn`, `signingOut`, `storageBlocked` |
| `providers` | 배포 설정에서 enable한 provider allowlist. 서버 provider gate가 미해소면 해당 버튼을 표시하지 않음; renderer가 enable할 수 없음 |
| `login` | 로그인 진행 중 `{attemptId,provider,expiresAt}` 또는 null. attemptId는 main의 임의 UUID로 server requestId와 별개; startingLogin의 expiresAt은 null |
| `user` | signedIn에서만 `{nickname:string}`, 그 밖은 null. API user ID·session ID·provider identity는 노출 불필요 |
| `entry` | signedIn에서 `welcome` 또는 `home`, 그 밖은 null. 서버 exchange의 isNewUser로 최초 진입을 정하고 복원은 home |
| `notice` | null 또는 아래 고정 enum. UI는 자체 고정 한국어 문구를 사용 |

`notice`는 `LOGIN_CANCELLED`, `LOGIN_EXPIRED`, `LOGIN_RETURN_INVALID`, `LOGIN_RESTART_REQUIRED`, `BROWSER_OPEN_FAILED`, `NETWORK_UNAVAILABLE`, `AUTH_SERVICE_UNAVAILABLE`, `REAUTH_REQUIRED`, `SECURE_STORAGE_UNAVAILABLE`, `TOKEN_SAVE_FAILED`, `LOCAL_CLEAR_UNCONFIRMED`, `LOGOUT_SERVER_UNCONFIRMED`만 허용한다. `phase`가 허용 action을 결정한다. Server logout·local 삭제 둘 다 실패하면 `storageBlocked/LOCAL_CLEAR_UNCONFIRMED`가 우선이고 문구에서 서버 완료도 미확인임을 함께 안내한다.

Preload event는 고정 channel 하나에서 DTO만 전달하고 개별 wrapper를 제거한다. Renderer는 먼저 subscribe한 뒤 `getAuthState`를 호출한다. 같은 runId에서는 큰 revision만 적용하므로 늦은 invoke 응답이 새 event를 덮지 않는다. Reload는 새 구독 후 조회하고 unmount 때 해제한다. Main 재연결로 runId가 달라지면 이전 bridge/subscription을 버린 뒤 새 조회로 기준을 세운다.

## Main trust boundary

모든 invoke에서 side effect 전에 다음을 검사한다. TypeScript type만으로 통과시키지 않는다.

1. `event.sender`가 살아 있는 등록 main window의 `webContents`와 동일하고 `event.senderFrame === window.webContents.mainFrame`이어야 한다. Subframe, 다른 window, destroyed/null frame은 거절한다.
2. Sender frame의 현재 document URL은 packaged renderer entry의 exact file URL이어야 한다. Dev는 main이 시작 시 확인한 exact local dev URL만 허용한다. Prefix/hostname substring 비교나 renderer가 준 origin을 사용하지 않는다. Navigation 뒤 매 호출 재검사하며 about:blank/외부 화면은 허용하지 않는다.
3. 인자 수까지 검사한다. Object는 null/array를 제외하고 exact own keys, string enum과 canonical UUID를 검사한다. Unknown key·coercion·과도한 string을 거절한다. URL·code·verifier·token·clientId·userId·sessionId·path를 받는 IPC는 없다.
4. 현재 phase, enabled provider, attemptId, generation을 검사한다. Async 완료와 event 발행 전에도 generation/window identity를 재확인한다. Clock/deadline 및 외부 응답 검증은 lifecycle을 따른다.

이 검사는 UI script의 privileged API 남용 범위를 줄이지만 허용된 renderer 자체가 침해됐을 때 사용자 클릭 의도를 증명하지는 않는다. Header/token 생성·file/URL 선택은 언제나 main이다.

## 최소 화면과 capture 경계

| 상태 | 화면·action |
| --- | --- |
| signedOut | 서비스 로그인, enable된 Google/Discord 버튼, 정제 실패 안내. 회원가입 별도 form 없음. 같은 email의 다른 provider가 별개 계정이라는 안내 |
| startingLogin / waitingBrowser | 브라우저에서 계속하라는 안내·현재 attempt 취소. 대기 화면에 만료 안내, 다시 로그인은 취소 완료 뒤 새 beginLogin. 사용한 launch URL 재열기 버튼 없음 |
| exchanging / restoring | 로그인 처리/복원 중 표시. 복원 중 보호 화면 노출 없음. Exchange 취소는 서버 rollback을 뜻하지 않는다는 lifecycle 동작 적용 |
| restorePaused | 연결 실패 안내·retryAuth·현재 기기 logout. 저장된 credential을 검증 완료로 표시하지 않음 |
| signedIn + welcome | 새 회원 환영, 서버 기본 nickname을 text로 표시, “시작하기”로 기존 capture 화면 진입. 추가 개인정보·필수 nickname 입력 없음 |
| signedIn + home | 기존 capture UI와 nickname/현재 기기 logout. 기존 회원과 앱 재시작은 바로 이 화면 |
| signingOut / storageBlocked | 정리 중 또는 안전한 저장/삭제 실패 안내. storageBlocked는 retryAuth만 허용하고 새 로그인·보호 기능을 차단 |

Welcome 닫힘은 renderer의 이번 mount 내 navigation 상태다. Reload 시 welcome을 다시 보여줄 수 있으며 onboarding 완료 API·영구 flag를 추가하지 않는다. 신규 기본 nickname, 기존 nickname 보존, safe text 출력은 auth-api 계약을 따른다. Nickname 편집·검색 후보/등록 목록·탈퇴 화면은 이 최소 로그인 flow의 선행 조건이 아니며 후속 task다.

Capture component는 signedIn home에서 mount한다. 로그인 이탈 시 unmount→기존 stream/worker/loop cleanup, 화면 후보·인식값 제거, main의 선택 source 해제를 수행한다. 재로그인 후 자동 capture를 시작하지 않고 source 선택·Start gesture를 다시 요구한다. 이후 인증된 검색을 연결할 때 기존 `notifyStableNicknameDetected` entry에서 main auth generation을 확인하고 현재 session의 HTTP만 수행한다. 늦은 OCR/검색 결과는 capture generation과 auth generation이 모두 맞을 때만 표시한다. 로그아웃 후 residual JWT 검색이 서버에서 가능하더라도 앱은 token을 사용하지 않는다. 현재 log-only handler를 이미 인증 검색으로 구현했다고 표시하지 않는다.

이 화면 조건은 main 권한 검사를 대신하지 않는다. 후속 인증 연결에서는 `listCaptureSources`, 비어 있지 않은 source 선택, `notifyStableNicknameDetected`, display-media 허용에 main의 signedIn 검사를 추가한다. Source 열거/선택·media callback의 async 완료 직전에도 시작 auth generation과 현재 signedIn을 재검사하며 이탈했다면 목록/선택 성공을 반환하거나 stream을 허용하지 않는다. 기존 sender/frame/source/user-gesture 검사는 유지한다. 인증 이탈 시 main이 선택을 직접 무효화하고, trusted renderer의 빈 source 선택은 phase와 무관하게 cleanup용으로 허용한다. Renderer도 unmount된 capture instance의 late OCR 완료가 IPC를 보내지 않게 검사한다. Main이 이후 생성하는 검색 작업은 시작 auth generation에 묶는다.

이 연결 경로의 기존 raw OCR nickname log도 제거하고 비민감 counter만 허용한다. 화면의 nickname text 표시와 진단 log 보관은 별개다. Auth 경계 밖의 무관한 module refactoring을 요구하는 것은 아니다.

## 승인 대상과 서버 별도 결정

권장안은 main 단독 소유 + feature IPC + memory-only pending/access + 암호화 refresh 보관 + 등록 private protocol + 최소 welcome/home이다. Renderer token 보관은 bridge 노출면을 늘리고, provider embedded login은 승인된 외부 browser 경계와 다르므로 채택하지 않는다. 저장/protocol의 실질 대안 비교는 platform 문서에 둔다.

이 flow에 필수인 서버 정책 변경은 없다. Browser 취소를 앱에 즉시 push하는 기능, 서버 pending 취소/status endpoint, code/refresh 응답 유실의 idempotent 재전달, onboarding 완료 저장, 계정 연결은 현 API에 없다. 필요해지면 별도 서버 Rule 결정으로 제시한다. 이번 설계는 polling·error URL parameter·refresh grace를 몰래 추가하지 않는다.
