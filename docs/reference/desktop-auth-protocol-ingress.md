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
2. `app.requestSingleInstanceLock()`을 호출한다. lock loser는 `app.quit()`만 호출하고 listener·dispatch·인증 core 초기화를 만들지 않는다.
3. lock owner는 즉시 `open-url`과 `second-instance` listener를 등록한다. `open-url`은 항상 `preventDefault()`를 먼저 호출한다.
4. 초기 `argv`와 두 event의 입력은 target의 scheme으로 보이는 문자열만 후보로 세고, 후보가 정확히 하나일 때만 기존 `parseReturnUrl`을 적용한다. canonical code-only raw URL 하나만 다음 단계로 전달한다.

반환 객체의 `ownsInstance`는 lock 결과를 나타내며, `attach(dispatch)`는 dispatch를 연결하고 disposer를 반환한다. Main composition은 `attachProtocolIngressAfterStart(ingress, start, dispatch, isActive)`를 사용해 `start()` Promise가 성공적으로 끝난 뒤에만 실제 `attach`를 호출하고 buffered return을 dispatch한다. Start 대기 중에는 ingress의 기존 bounded pending 후보 보관 규칙을 유지하며, Start rejection은 ingress를 폐기한다. 제품 main은 정상 복원 실패가 terminal/retry 상태로 resolve된다는 coordinator 계약과 예상 밖 rejection을 구분하고, 후자는 nonzero 종료해 영구 `restoring` owner를 남기지 않는다. 그 사이 quit으로 `isActive()`가 false가 되거나 반환된 disposer가 먼저 실행되면 나중에 attach하지 않는다. `dispose()`는 두 Electron listener, 연결된 dispatch와 아직 전달하지 않은 초기 후보를 함께 정리한다. Adapter는 window를 만들거나 focus하지 않으므로 창이 없을 때도 동일하게 raw return을 dispatch하며, 창 복원·focus와 coordinator 상태 판정은 composition 및 coordinator의 책임이다.

## 입력과 수명

- 초기 `argv`는 전체 배열을 검사한다. executable path, `--`와 일반 argument는 protocol scheme 후보가 아니므로 무시한다. Scheme 대소문자 변형도 다중 후보 판정에는 포함하지만, 실제 전달은 기존 exact parser를 통과한 raw 값만 허용한다.
- `second-instance`의 command line도 마지막 argument라고 가정하지 않고 전체를 검사한다.
- 하나의 event/초기 배열에 trusted scheme 후보가 두 개 이상이면 모두 거절한다. 잘못된 code가 섞여 있어도 후보가 여러 개면 dispatch하지 않는다.
- 후보 하나가 2,048-byte를 넘거나 exact target·canonical 32-byte base64url code가 아니면 dispatch하지 않는다. 입력을 trim, coerce, URL-decode하거나 재구성하지 않는다.
- dispatch가 아직 연결되지 않았을 때는 유효한 후보 하나만 임시 보관한다. 이후 후보는 queue하지 않는다. `attach`는 보관 후보를 한 번 전달한 뒤 비운다.
- `attach`가 연결된 warm event는 검증 후 즉시 dispatch한다. `detach` 중 발생한 첫 유효 후보는 다음 `attach`까지 보관할 수 있다. `dispose` 뒤에는 event와 후보를 처리하지 않는다.
- dispatch가 반환하는 비동기 실패는 ingress가 raw 오류를 공개하거나 process를 깨뜨리지 않도록 관찰만 하고, 인증 실패 의미는 coordinator가 소유한다.

`parseReturnUrl`은 adapter와 coordinator에서 각각 적용될 수 있다. Adapter의 첫 적용은 OS 입력을 안전하게 선별하기 위한 것이고, coordinator의 적용은 pending·generation·duplicate claim을 포함한 인증 lifecycle의 최종 판정이다. 따라서 pending 없는 cold 복귀는 exchange나 signed-in 상태를 만들지 않으며 coordinator가 `LOGIN_RESTART_REQUIRED`를 공개한다.

## Composition 인계 예시

제품 `main.ts`는 다음 순서를 유지한다. 완전한 trusted identity/profile tuple을 ready 이전에 적용하고 그 다음 ingress를 만든다. Owner 확인 뒤 ready에서 저장소 접근 안내와 coordinator dependency를 구성하며, window·IPC·activate를 연결한 다음 restore `start()`를 호출한다. Buffered return은 start가 성공한 뒤에만 dispatch한다.

```ts
const appliedConfig = applyAuthRuntimeProfile(app, config)
const ingress = createProtocolIngress({
  app,
  argv: process.argv,
  returnTarget: appliedConfig.returnTarget
})
if (!ingress.ownsInstance) {
  return
}

await app.whenReady()
const effects = createAuthRuntimeEffects({ config: appliedConfig })
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
        dispatchReturnUrlAndFocusWindow,
        () => !protocolIngressDisposed
      )

// window·IPC composition이 끝난 뒤 종료 시 다음을 실행한다.
detachProtocol?.()
ingress.dispose()
```

실제 composition에서는 `returnTarget`, coordinator의 시작과 window 초기화 사이의 입력 보관을 유지해야 한다. 안내 실패로 runtime이 만들어지지 않으면 ingress를 폐기하지만 적용된 profile owner와 비인증 window는 유지한다. 초기 restore가 reject하거나 quit이 시작되면 보관된 return을 전달하지 않는다. Lock loser 경로에서 store/network/window를 만들지 않고, cold input을 pending login의 증거로 승격하지 않으며, warm 또는 창 없는 복귀를 임의 navigation으로 바꾸지 않는다. URL 없는 정상 `second-instance`는 최소화된 기존 local window를 복원한 뒤 표시·focus하며, 해당 window side effect가 throw해도 Electron event 밖으로 전파하지 않는다. Protocol return listener가 먼저 coordinator 처리를 시작한 뒤 window를 활성화하고, 뒤의 일반 `second-instance` listener도 같은 event에서 예외를 회수한다. Window 활성화가 실패해도 이미 시작한 callback 처리는 기다리므로 유효 return을 UI side effect 때문에 버리지 않는다. `app.whenReady()`를 기다리기 전 listener 등록은 macOS `open-url` 유실을 줄이지만 packaged cold/warm·다중 instance·실제 OS association 성공을 증명하지 않는다.

## 검증 범위

`apps/desktop/src/backend/auth/protocol-ingress.test.ts`는 fake app/event와 합성 target/code만 사용해 lock owner/loser, ready 전 listener, 초기 argv, `open-url`·`second-instance`, 다중 후보 거절, 2,048-byte 경계, attach/detach/dispose, 창 없는 dispatch, initial restore 완료 뒤 cold 복귀, start 실패·quit 중 폐기를 확인한다. `apps/desktop/src/backend/main.test.ts`는 일반 composition에서는 ingress를 mock해 최소화 복원·동기 window 예외 회수·예상 밖 start rejection 종료를 확인하고, 별도 사례에서는 actual ingress module을 같은 fake Electron app에 연결해 protocol/general 두 listener의 등록 순서, callback 1회와 지속적인 window 예외 회수를 함께 실행한다. 실제 Electron EventEmitter와 packaged OS event 결합은 이 unit test로 증명하지 않는다.

실제 protocol registry, packaged cold/warm 실행, 설치 후 default handler, 서명/업데이트, OS focus, Keychain·credential store와 OAuth provider는 이 문서와 unit test의 검증 범위가 아니다. 해당 결과는 선택한 OS/package와 실제 등록 tuple이 확정된 후 별도 native validation으로 기록한다.
