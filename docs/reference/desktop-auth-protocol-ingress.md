---
type: reference
status: active
scope: apps/desktop protocol ingress and single-instance bootstrap
last-reviewed: 2026-09-11
---

# Desktop Auth Protocol Ingress

`apps/desktop/src/backend/auth/protocol-ingress.ts`는 Electron의 process-level protocol 입력을 인증 core의 `handleReturnUrl` 같은 dispatch 함수에 연결하는 main 전용 adapter다. 실제 protocol registry, API origin, app identity와 OS package 설정을 소유하지 않는다. 그 값은 trusted composition이 주입하며 현재 source에는 placeholder를 두지 않는다.

## 공개 경계

`createProtocolIngress({ app, argv, returnTarget })`를 main이 `app.whenReady()`보다 먼저 호출한다. Adapter는 다음 순서로 동작한다.

1. `returnTarget`을 기존 `validateReturnTarget`으로 확인한다.
2. `app.requestSingleInstanceLock()`을 호출한다. lock loser는 `app.quit()`만 호출하고 listener·dispatch·인증 core 초기화를 만들지 않는다.
3. lock owner는 즉시 `open-url`과 `second-instance` listener를 등록한다. `open-url`은 항상 `preventDefault()`를 먼저 호출한다.
4. 초기 `argv`와 두 event의 입력은 target의 scheme으로 보이는 문자열만 후보로 세고, 후보가 정확히 하나일 때만 기존 `parseReturnUrl`을 적용한다. canonical code-only raw URL 하나만 다음 단계로 전달한다.

반환 객체의 `ownsInstance`는 lock 결과를 나타내며, `attach(dispatch)`는 인증 core가 준비된 뒤 dispatch를 연결하고 disposer를 반환한다. `dispose()`는 두 Electron listener, 연결된 dispatch와 아직 전달하지 않은 초기 후보를 함께 정리한다. Adapter는 window를 만들거나 focus하지 않으므로 창이 없을 때도 동일하게 raw return을 dispatch하며, 창 복원·focus와 coordinator 상태 판정은 composition 및 coordinator의 책임이다.

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

제품 `main.ts`는 다음 순서를 유지한다. Trusted return target이 있을 때만 ready 이전에 ingress를 만들고, owner 확인 뒤 저장소 접근 안내와 coordinator 시작을 수행한다.

```ts
const ingress = createProtocolIngress({ app, argv: process.argv, returnTarget })
if (!ingress.ownsInstance) {
  return
}

await app.whenReady()
const runtime = await bootstrapAuthRuntime({ config, effects })
if (runtime == null) {
  return
}
const detachProtocol = ingress.attach(dispatchReturnUrlAndFocusWindow)

// window·IPC composition이 끝난 뒤 종료 시 다음을 실행한다.
detachProtocol()
ingress.dispose()
```

실제 composition에서는 `returnTarget`, coordinator의 시작과 window 초기화 사이의 입력 보관을 유지해야 한다. lock loser 경로에서 store/network/window를 만들지 않고, cold input을 pending login의 증거로 승격하지 않으며, warm 또는 창 없는 복귀를 임의 navigation으로 바꾸지 않는다. `app.whenReady()`를 기다리기 전 listener 등록은 macOS `open-url` 유실을 줄이지만 packaged cold/warm·다중 instance·실제 OS association 성공을 증명하지 않는다.

## 검증 범위

`apps/desktop/src/backend/auth/protocol-ingress.test.ts`는 fake app/event와 합성 target/code만 사용해 lock owner/loser, ready 전 listener, 초기 argv, `open-url`·`second-instance`, 다중 후보 거절, 2,048-byte 경계, attach/detach/dispose, 창 없는 dispatch와 pending 없는 coordinator 복귀를 확인한다. 외부 network·browser·window navigation counter는 adapter에 없으며 dispatch 경계 밖 side effect도 발생하지 않는다.

실제 protocol registry, packaged cold/warm 실행, 설치 후 default handler, 서명/업데이트, OS focus, Keychain·credential store와 OAuth provider는 이 문서와 unit test의 검증 범위가 아니다. 해당 결과는 선택한 OS/package와 실제 등록 tuple이 확정된 후 별도 native validation으로 기록한다.
