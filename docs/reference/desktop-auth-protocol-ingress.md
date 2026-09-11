---
type: reference
status: active
scope: apps/desktop protocol ingress and single-instance bootstrap
last-reviewed: 2026-09-12
---

# Desktop Auth Protocol Ingress

`apps/desktop/src/backend/auth/protocol-ingress.ts`는 Electron의 process-level protocol 입력을 인증 core의 `handleReturnUrl` 같은 dispatch 함수에 연결하는 main 전용 adapter다. 실제 protocol registry, API origin, app identity와 OS package 설정을 소유하지 않는다. 그 값은 trusted composition이 주입하며 현재 source에는 placeholder를 두지 않는다.

## 공개 경계

`createProtocolIngress({ app, argv, returnTarget })`를 main이 `app.whenReady()`보다 먼저 호출한다. Adapter는 다음 순서로 동작한다.

1. `returnTarget`을 기존 `validateReturnTarget`으로 확인한다.
2. Main이 packaged 실행에서는 `process.argv.slice(1)`, Electron `defaultApp` 개발 실행에서는 `slice(2)`로 executable과 app path를 제거한다. Adapter는 남은 user argv를 bounded/versioned JSON handoff로 만들어 `app.requestSingleInstanceLock(additionalData)`에 전달한다.
3. lock owner는 즉시 `open-url`과 `second-instance` listener를 등록한다. `open-url`은 항상 `preventDefault()`를 먼저 호출한다.
4. 초기 user argv와 `open-url` raw 값, `second-instance`의 validated handoff argv는 target의 scheme으로 보이는 문자열만 후보로 세고, 후보가 정확히 하나일 때만 기존 `parseReturnUrl`을 적용한다. canonical code-only raw URL 하나만 다음 단계로 전달한다. Lock loser는 `app.quit()`만 호출하고 listener·dispatch·인증 core 초기화를 만들지 않는다.

반환 객체의 `ownsInstance`는 lock 결과를 나타내며, `attach(dispatch, activate?)`는 auth dispatch와 URL 없는 일반 `second-instance`의 window activation callback을 연결하고 disposer를 반환한다. Main composition은 `attachProtocolIngressAfterStart(ingress, start, dispatch, isActive, activate)`를 사용해 `start()` Promise가 성공적으로 끝난 뒤에만 실제 `attach`를 호출한다. Start 대기 중에는 유효 return 하나와 일반 활성화 여부 하나만 보관하며, Start rejection은 ingress를 폐기한다. 제품 main은 정상 복원 실패가 terminal/retry 상태로 resolve된다는 coordinator 계약과 예상 밖 rejection을 구분하고, active owner의 후자는 nonzero 종료해 영구 `restoring`을 남기지 않는다. 정상 quit 뒤의 늦은 rejection은 종료 상태를 바꾸지 않는다. 그 사이 quit으로 `isActive()`가 false가 되거나 반환된 disposer가 먼저 실행되면 나중에 attach하지 않는다. `dispose()`는 두 Electron listener, 연결된 callback과 아직 전달하지 않은 후보·활성화를 함께 정리한다. Adapter는 window를 직접 만들거나 focus하지 않으며, callback 예외는 Electron event 밖으로 전파하지 않는다.

## 입력과 수명

- Main은 process bootstrap argument를 먼저 제거하므로 adapter의 초기 `argv`에는 user argument만 들어간다. Electron이 `second-instance`의 `commandLine` 순서와 내용을 바꿀 수 있으므로 owner는 그 배열을 인증 판정에 사용하지 않고 loser가 lock과 함께 보낸 handoff만 다시 검증한다.
- Handoff는 exact own key `version`·`argv`만 가진 version 1 객체다. 최대 64개 argument, argument당 UTF-8 4,096 byte, 전체 16,384 byte를 허용한다. 누락·버전/shape/type 오류·초과 입력은 auth와 일반 activation 모두 없이 fail closed한다.
- URI scheme 형태가 전혀 없으면 일반 실행으로 분류해 activation만 호출하고, exact valid 후보 하나면 auth dispatch만 호출한다. Trusted scheme 후보가 malformed·여러 개이거나 앞쪽 whitespace/control·parser가 무시하는 내부 TAB/LF/CR을 포함한 다른 URL-like 입력이 있으면 둘 다 호출하지 않는다. Well-formed scheme뿐 아니라 path/query/fragment 구분자 없는 prefix 뒤의 colon과 slash 또는 backslash로 시작하는 hierarchical 형태도 malformed URL-like 입력군으로 취급한다. `--` 또는 slash prefix 뒤 첫 `=`/`:`로 구분되는 structured option은 이름의 punctuation이나 빈 이름에 의존하지 않고 payload에도 같은 URL-like 검사를 적용한다. Slash prefix 이름에 path separator가 있으면 POSIX path로 유지한다. 예외는 대소문자를 정규화한 이름이 정확히 `user-data-dir`이고 raw argument와 payload가 trim/control projection 없이 exact이며, payload가 drive letter와 colon 뒤에 slash 또는 backslash가 정확히 하나인 absolute Windows drive 형태(`C:/...`, `C:\...`)일 때뿐이다. Scheme 형태가 아닌 `/tmp/report:2026.txt`, `--label=12:30`, 내부 space 뒤 colon은 일반 argument다. 반대로 bootstrap에서 제거되지 않은 direct `C:\...`, `C:/...`, `C:relative` user argument와 다른 option의 drive-shaped payload, control projection 뒤에만 drive path가 되는 값은 one-letter URI와 어휘적으로 모호하므로 fail closed한다. Detection projection은 raw 값을 보정하지 않으며 세 결과는 단일 Electron listener가 소유한다.
- 하나의 event/초기 배열에 trusted scheme 후보가 두 개 이상이면 모두 거절한다. 잘못된 code가 섞여 있어도 후보가 여러 개면 dispatch하지 않는다.
- 후보 하나가 2,048-byte를 넘거나 exact target·canonical 32-byte base64url code가 아니면 dispatch하지 않는다. 입력을 trim, coerce, URL-decode하거나 재구성하지 않는다.
- dispatch가 아직 연결되지 않았을 때는 유효한 후보 하나와 일반 활성화 여부 하나만 임시 보관한다. 이후 후보와 일반 실행을 queue하지 않는다. `attach`는 보관한 두 종류를 각각 최대 한 번 전달한 뒤 비운다.
- `attach`가 연결된 warm event는 검증 후 즉시 dispatch한다. `detach` 중 발생한 첫 유효 후보는 다음 `attach`까지 보관할 수 있다. `dispose` 뒤에는 event와 후보를 처리하지 않는다.
- dispatch와 activation이 반환하는 비동기 실패는 ingress가 raw 오류를 공개하거나 process를 깨뜨리지 않도록 관찰만 하고, 인증 실패 의미는 coordinator가 소유한다.

`parseReturnUrl`은 adapter와 coordinator에서 각각 적용될 수 있다. Adapter의 첫 적용은 OS 입력을 안전하게 선별하기 위한 것이고, coordinator의 적용은 pending·generation·duplicate claim을 포함한 인증 lifecycle의 최종 판정이다. Main은 coordinator의 optional `onClaimed` callback으로 새 valid pending claim 뒤에만 window를 활성화한다. Exchange는 callback보다 먼저 시작하며 callback의 동기 throw와 반환 Promise rejection은 best-effort UI 실패로 관찰하고 exchange를 취소하지 않는다. Pending 없는 cold 복귀, expired·ignored·joined duplicate는 이 callback을 실행하지 않는다. Pending 없는 복귀는 exchange나 signed-in 상태를 만들지 않으며 coordinator가 `LOGIN_RESTART_REQUIRED`를 공개한다.

## Composition 인계 예시

제품 `main.ts`는 다음 순서를 유지한다. 완전한 trusted identity/profile tuple을 ready 이전에 적용하고 그 다음 ingress를 만든다. Owner 확인 뒤 ready에서 저장소 접근 안내와 coordinator dependency를 구성하며, window·IPC·activate를 연결한 다음 restore `start()`를 호출한다. Buffered return은 start가 성공한 뒤에만 dispatch한다.

```ts
const appliedConfig = applyAuthRuntimeProfile(app, config)
const ingress = createProtocolIngress({
  app,
  argv: selectProtocolIngressArguments(process.argv, process.defaultApp === true),
  returnTarget: appliedConfig.returnTarget
})
if (!ingress.ownsInstance) {
  return
}

await app.whenReady()
const effects = createAuthRuntimeEffects()
const runtime = await bootstrapAuthRuntime({ config: appliedConfig, effects })
registerWindowAndIpc(runtime)
registerActivateLifecycle(runtime)
const start = runtime?.start()
const detachProtocol =
  runtime == null || start == null
    ? undefined
    : attachProtocolIngressAfterStart(
        ingress,
        start,
        (rawReturnUrl) =>
          runtime.coordinator.handleReturnUrl(rawReturnUrl, activateWindowSafely),
        () => !isQuitting && !protocolIngressDisposed,
        activateWindowSafely
      )

// window·IPC composition이 끝난 뒤 종료 시 다음을 실행한다.
detachProtocol?.()
ingress.dispose()
```

실제 composition에서는 `returnTarget`, coordinator의 시작과 window 초기화 사이의 입력 보관을 유지해야 한다. 안내 실패로 runtime이 만들어지지 않으면 ingress를 폐기하지만 적용된 profile owner와 비인증 window는 유지한다. 이 fallback은 같은 validated handoff classifier로 URL 없는 일반 `second-instance`만 활성화하고 protocol-like argv를 무시한다. 예상 밖 dependency·clock·coordinator·owned composition 예외와 active `start()` rejection은 ingress 폐기 뒤 nonzero 종료한다. `before-quit`과 `will-quit` 동안에는 activation과 뒤늦은 구성을 중단하지만 ingress는 유지한다. 그동안 bootstrap/start가 끝나거나 protocol callback/activation을 받으면 quit 결과까지 보류하고, event·window close·renderer beforeunload가 종료를 취소할 때 한 번 재개한다. `quit`이 실제 종료를 확정하면 보류 결과를 폐기하고 ingress를 닫는다. Quit이 notice를 기다리는 중 시작되면 dependency·IPC·window·restore를 뒤늦게 만들지 않는다. Window는 모든 동기 wiring과 load 시작 뒤에만 publish한다. 구성 실패는 미공개 window·부분 auth IPC를 rollback하고, current owned document load rejection은 fatal이다. Cancelable `close` 시도와 겹친 rejection은 결과가 정해질 때까지 보류한다. `closed`가 오면 정상 종료로 폐기하고, 동기 event 또는 renderer `beforeunload`가 close를 취소하면 같은 rejection을 다시 fatal 경계에서 처리한다. 이미 교체됐거나 확정된 정상 quit 뒤에 도착한 늦은 rejection은 현재 owner를 건드리지 않는다. Lock loser 경로에서 store/network/window를 만들지 않고, cold input을 pending login의 증거로 승격하지 않으며, warm 또는 창 없는 복귀를 임의 navigation으로 바꾸지 않는다. 단일 `second-instance` listener는 URL 없는 일반 실행만 최소화된 기존 local window의 복원·표시·focus로 보내고 malformed·복수·wrong-scheme return과 다른 URL 입력은 UI와 auth 모두에 전달하지 않는다. Exact valid return도 coordinator가 새 pending을 claim한 경우에만 exchange 시작 뒤 window를 활성화한다. Window 활성화가 실패해도 이미 시작한 callback 처리를 버리지 않는다. `app.whenReady()`를 기다리기 전 listener 등록은 macOS `open-url` 유실을 줄이지만 packaged cold/warm·다중 instance·실제 OS association 성공을 증명하지 않는다. 기존 parser가 허용하는 one-letter private scheme 문법은 이 PR에서 임의로 축소하지 않았으며, Windows drive namespace와 충돌하지 않는 실제 owned scheme 선택은 배포 gate다.

## 검증 범위

`apps/desktop/src/backend/auth/protocol-ingress.test.ts`는 fake app/event와 합성 target/code만 사용해 lock owner/loser, packaged/defaultApp bootstrap 제거, ready 전 listener, 초기 argv, `open-url`·versioned handoff tri-state 분류, mutable commandLine 무시, exact-key/version/type와 64/4,096/16,384 UTF-8 byte 경계, wrong-scheme·malformed hierarchical·다중 후보·structured option payload·모호한 direct/unknown-option drive 입력 거절, known `user-data-dir` absolute drive payload 예외, colon-bearing 일반 argument, 2,048-byte return 경계, attach/detach/dispose, bounded 일반 활성화, initial restore 완료 뒤 cold 복귀, start 실패·quit 중 폐기를 확인한다. `apps/desktop/src/backend/main.test.ts`는 일반 composition에서는 ingress를 mock해 pre-lock profile 적용 순서, defaultApp user argv, 최소화 복원, transactional window/IPC와 current/stale/quit load rejection, close 중 rejection의 `closed` 완료·동기 취소·renderer beforeunload 취소 결과, before/will-quit 취소 뒤 activation 복구, 보류한 load/start failure 재처리, 예상 밖 구성/active start rejection 종료를 확인한다. 별도 사례에서는 actual ingress module을 같은 fake Electron app에 연결해 단일 listener, callback claim 1회, malformed·복수·wrong-scheme·pending 없는 입력의 window side effect 0을 검사한다. 실제 Electron EventEmitter와 packaged OS event 결합은 이 unit test로 증명하지 않는다.

실제 protocol registry, packaged cold/warm 실행, 설치 후 default handler, 서명/업데이트, OS focus, Keychain·credential store와 OAuth provider는 이 문서와 unit test의 검증 범위가 아니다. 해당 결과는 선택한 OS/package와 실제 등록 tuple이 확정된 후 별도 native validation으로 기록한다.
