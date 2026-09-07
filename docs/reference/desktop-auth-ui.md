---
type: reference
status: current
scope: desktop renderer auth presentation and isolated fixture
last-reviewed: 2026-09-07
---

# Desktop Auth UI

## Source와 연결 경계

`apps/desktop/src/frontend/src/auth/AuthPresentation.tsx`는 `presentation.ts`의 renderer-local input을 표시하고 `onIntent` callback으로 의도를 전달한다. 원본 contract는 [`Desktop Authentication`](../rules/desktop-auth.md)과 [`lifecycle`](../rules/desktop-auth-lifecycle.md)다. Local type은 실제 IPC public type이나 runtime DTO validator가 아니다.

- `snapshot`이 표시할 phase·provider·계정·entry·고정 notice를 결정한다. Command callback 자체로 signedIn을 만들지 않는다.
- `commandPending`은 후속 adapter가 전달할 버튼 대기 상태다. Invocation 결과를 기다리거나 snapshot을 재동기화하는 동안 true를 유지한다. 취소 완료 snapshot 전 새 provider 선택을 만들지 않는다.
- `SignedIn`의 welcome dismissal만 React mount에 남는다. 같은 mount의 입력 갱신은 dismissal을 유지하고 signedIn 이탈·전체 unmount는 초기화한다. `시작하기`는 local navigation이며 auth intent를 보내지 않는다.
- Home에는 계정·후속 화면 캡처 안내와 logout이 있다. 실제 capture hook·media·OCR는 mount하지 않는다.
- 후속 adapter가 승인된 DTO allowlist, 실제 subscribe/getAuthState 순서·runId/revision, IPC 결과 재동기화, bootstrap과 capture 인증 경계를 맡는다. 현재 `App.tsx`와 main/preload는 연결하지 않았다.

## 공용 표현

`@ldb/ui`의 `LayoutBlock`, `ContentStack`, `ExampleSection`, `SupportingText`, `ActionButton`을 그대로 소비한다. SEED Theme 초기화와 system font는 fixture entry의 `@seed-design/css/base.css`, `@ldb/ui/foundation.css` 및 공식 Vite plugin을 따른다. 화면 CSS·style·className override와 추가 framework는 없다.

고정 조합은 `@seed-design/react@2.4.1`, `@seed-design/css@2.7.0`, `@seed-design/vite-plugin@2.1.0`이다. 공식 ActionButton·Layout source 기준은 `packages/ui/seed-provenance.json`의 `08b3600989597f4e9017731484a409685c08aa68`이다. 전체 auth 화면은 공식 auth Template 복제가 아닌 기존 LDB composition의 제품 content 조합이다. 기존 공용 appearance·Motion을 변경하지 않았다.

## 격리 fixture 실행

Repository root에서 기존 lockfile dependency를 설치한 뒤 실행한다.

```sh
pnpm install --frozen-lockfile
pnpm --filter @ldb/desktop exec vite build --config scripts/auth-ui-fixture.config.ts
pnpm --filter @ldb/desktop exec electron scripts/auth-ui-fixture.mjs light
pnpm --filter @ldb/desktop exec electron scripts/auth-ui-fixture.mjs dark --force-prefers-reduced-motion
```

Fixture source는 `apps/desktop/src/frontend/auth-fixture/`이며 output은 `apps/desktop/out/auth-ui-fixture/`다. 제품 renderer build와 별도로 생성한다. `scripts/auth-ui-fixture.mjs`는 별도 임시 userData, sandbox·contextIsolation, nodeIntegration off, preload 없음으로 실행한다. Permission을 거절하고 file·내장 devtools resource 외 요청과 새 window·renderer navigation을 차단한다. OAuth·credential store·제품 auth/capture module을 실행하지 않는다. 종료 시 임시 userData를 정리하며 native filesystem의 일시적인 종료 경합에는 제한된 재시도를 사용한다.

macOS의 Electron application menu에서 phase·invalidReturn·welcome/home·longNickname·noProviders를 선택한다. Light/Dark와 Narrow 360(360×740 content)/Wide 1100(1100×770 content)을 전환할 수 있다. 최초 window는 1100×800 outer size다. State 선택·Reload는 React를 다시 mount한다. App menu를 사용한 Theme·viewport 변경은 현재 mount를 보존한다.

Fixture의 provider 선택은 800ms 후 Synthetic waitingBrowser, 취소는 signedOut/LOGIN_CANCELLED, retryAuth는 restoring, logout은 signingOut을 전달한다. 이 대기는 UI 검증을 위한 fixture 지연이며 제품 timeout 정책이 아니다. 자동 OAuth 성공이나 실제 계정 권한은 없다.

## Component/interaction evidence

```sh
pnpm --filter @ldb/desktop exec vitest run src/frontend/src/auth/AuthPresentation.test.tsx
pnpm --filter @ldb/desktop run --sequential '/^(test|lint|build)$/'
git diff --check
```

`AuthPresentation.test.tsx`는 실제 공용 component와 React DOM/jsdom을 사용한다. Red `a2fcd7d`는 빈 component scaffold에서 24개 assertion이 실패했으며, 통합 `1df14bc`에서도 재현 후 Green을 시작했다. Provider allowlist·현재 attempt·취소 후 snapshot 대기·복원/삭제 실패·보호 표시 제한·safe text·welcome mount·busy disabled를 검증한다. Assertion을 약화하거나 test를 skip하지 않았다.

Code result `bd5d5e1`에서 aggregate exit 0, 10 files/53 tests, lint, Desktop build와 포함된 두 typecheck가 통과했다. 별도 fixture Vite build도 통과했다. 최초 lint의 explicit return type·Fast Refresh entry 오류와 typecheck의 nullable expiry 오류는 수정 후 재검증했다. Build의 기존 npm `shamefully-hoist` 경고는 남는다. 최종 integration exact head gate는 PR evidence에서 별도로 기록한다.

## 실제 Electron 관측

2026-09-07 macOS 26.6.2 arm64, Electron 39.8.10 / Chromium 142.0.7444.265에서 CUA로 실제 window·AX tree·screenshot과 keyboard를 확인했다. Font는 공식 system stack의 `-apple-system`, `system-ui`, `Apple SD Gothic Neo` 등을 사용한다. Screenshot은 CUA tool image로 확인했으며 repository에 image 파일을 추가하지 않았다.

| 조건 | 직접 확인한 내용 |
| --- | --- |
| Light, 초기 wide(1100×768 content), signedOut→waitingBrowser | provider 표시, Tab/Shift+Tab focus, Enter intent, 대기 중 disabled, 다음 snapshot의 현재 attempt 취소 focus. |
| Dark, 360×740, startingLogin·exchanging·restoring·signingOut | 안내와 loading/disabled 표현, 보호 content 부재, exchange 취소 focus, restoring/signingOut의 activation 차단. |
| Dark, 360×740, invalidReturn | 새 로그인 Enter→취소 대기 중 두 action disabled→signedOut 안내. 대기 중 provider가 나타나지 않는다. |
| Dark, 360×740, restorePaused·storageBlocked | retry/logout 순서와 focus, logout 후 signingOut, storageBlocked의 retry만 노출 및 local/server 불명 안내. |
| Light/Dark, 360×740, 최대 nickname welcome→home | `W` 20 grapheme가 영역 안에 표시된다. 시작하기 Enter 후 home 계정·캡처 안내·logout 표시와 focus를 확인했다. |
| Dark, reduced-motion run | 실제 DevTools `matchMedia('(prefers-reduced-motion: reduce)').matches === true`, dark true, `window.api` undefined 확인. Keyboard provider activation과 busy 화면 전환 확인. Spinner의 reduced-motion 지속 관측은 아래 미검증 범위 참조. |

유효 최대 nickname 기준은 서버의 1–20 grapheme contract다. 범위 밖의 매우 긴 unbroken stress text는 공용 flex 영역을 넘었지만, 정상 최대 조건과 구분했다. 이 stress만으로 공용 API를 확대하거나 renderer에서 nickname을 잘라 표시하지 않았다. HTML 형태 string은 component test에서 text 출력과 element 미생성을 검증한다.

## 미검증·후속

- GUI 검증 중 host 잠금으로 reduced-motion spinner의 최종 시간차 관측과 마지막 fixture 종료 정리 재검증이 보류됐다. 잠금 해제 후 이 절과 PR evidence를 갱신한다. 공식 loading에 reduced-motion 중 회전이 남았다는 선행 PR #104 관측을 이번 실행 결과로 대체하지 않는다.
- 모든 상태×모든 viewport×모든 Theme의 전체 Cartesian matrix나 pixel 동등성을 주장하지 않는다. Button의 공식 loading 표현과 disabled는 구분하며 현재 화면은 둘을 함께 사용한다. 별도 page transition/Motion preset을 추가하지 않았다.
- 실제 OAuth·계정 API·IPC·native protocol·OS credential 저장·capture 통합, 다른 OS/runtime/font는 후속이다. Synthetic fixture 성공은 제품 인증 검증이 아니다.
