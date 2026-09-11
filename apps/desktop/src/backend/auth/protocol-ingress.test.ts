import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { bootstrapAuthRuntime } from './bootstrap'
import { createAuthCoordinator } from './coordinator'
import {
  attachProtocolIngressAfterStart,
  createProtocolIngress,
  isOrdinarySecondInstanceInvocation,
  type ProtocolIngressApp,
  type ProtocolOpenUrlEvent
} from './protocol-ingress'
import {
  CODE,
  OTHER_CODE,
  RETURN_TARGET,
  createAuthHarness,
  deferred,
  settle
} from './auth-test-fixtures'
import type { AuthRuntimeConfig } from './runtime-config'

const runtimeConfig: AuthRuntimeConfig = {
  apiOrigin: 'https://api.example.test',
  returnTarget: RETURN_TARGET,
  environment: 'test',
  providers: ['google', 'discord'],
  appIdentity: 'com.synthetic.ldb',
  userDataPath: '/synthetic/user-data'
}

class FakeApp extends EventEmitter {
  readonly calls: string[] = []
  lockResult = true

  requestSingleInstanceLock(): boolean {
    this.calls.push('requestSingleInstanceLock')
    return this.lockResult
  }

  quit(): void {
    this.calls.push('quit')
  }
}

function createApp(): FakeApp & ProtocolIngressApp {
  return new FakeApp() as FakeApp & ProtocolIngressApp
}

function returnUrl(code = CODE, returnTarget = RETURN_TARGET): string {
  return `${returnTarget}?code=${code}`
}

function openUrlEvent(): ProtocolOpenUrlEvent & { prevented: boolean } {
  return {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }
}

describe('Desktop auth protocol ingress', () => {
  it('lock loser는 listener와 dispatch를 만들지 않고 즉시 종료한다', () => {
    const app = createApp()
    app.lockResult = false
    const dispatch = vi.fn()
    const ingress = createProtocolIngress({ app, argv: ['electron'], returnTarget: RETURN_TARGET })

    expect(app.calls).toEqual(['requestSingleInstanceLock', 'quit'])
    expect(app.listenerCount('open-url')).toBe(0)
    expect(app.listenerCount('second-instance')).toBe(0)

    ingress.attach(dispatch)
    app.emit('open-url', openUrlEvent(), returnUrl())
    app.emit('second-instance', {}, ['electron', returnUrl()], '/tmp')

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('lock owner는 ready 전 listener를 등록하고 단일 초기 argv를 attach 시 전달한다', () => {
    const app = createApp()
    const raw = returnUrl()
    const ingress = createProtocolIngress({
      app,
      argv: ['electron', '--', raw],
      returnTarget: RETURN_TARGET
    })
    const dispatch = vi.fn()

    expect(app.calls).toEqual(['requestSingleInstanceLock'])
    expect(app.listenerCount('open-url')).toBe(1)
    expect(app.listenerCount('second-instance')).toBe(1)

    ingress.attach(dispatch)

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(raw)
  })

  it('macOS open-url은 preventDefault 후 warm dispatch하고 창이 없어도 입력을 버리지 않는다', () => {
    const app = createApp()
    const dispatch = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    const event = openUrlEvent()
    ingress.attach(dispatch)

    app.emit('open-url', event, returnUrl())

    expect(event.prevented).toBe(true)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(returnUrl())
  })

  it('second-instance는 argv 전체를 검사하고 복귀 후보가 두 개면 전체를 거절한다', () => {
    const app = createApp()
    const dispatch = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch)

    app.emit(
      'second-instance',
      {},
      ['electron', '--user-data-dir=/tmp/profile', returnUrl(), returnUrl(OTHER_CODE)],
      '/tmp'
    )

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('second-instance 일반 실행은 start 뒤 창을 활성화하고 start 전 반복 요청은 하나로 제한한다', async () => {
    const start = deferred<void>()
    const app = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })

    attachProtocolIngressAfterStart(ingress, start.promise, dispatch, () => true, activate)
    app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp')
    app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp')

    expect(dispatch).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()

    start.resolve()
    await settle()

    expect(dispatch).not.toHaveBeenCalled()
    expect(activate).toHaveBeenCalledTimes(1)

    app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp')
    await settle()

    expect(activate).toHaveBeenCalledTimes(2)
  })

  it('second-instance exact 복귀는 auth에만 전달하고 일반 활성화를 실행하지 않는다', () => {
    const app = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch, activate)

    app.emit('second-instance', {}, ['electron', returnUrl()], '/tmp')

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(returnUrl())
    expect(activate).not.toHaveBeenCalled()
  })

  it.each(['c://auth/return', 'c:/auth/return'])(
    'Windows drive prefix와 충돌하는 one-letter scheme %s는 lock 전에 거절한다',
    (returnTarget) => {
      const app = createApp()

      expect(() =>
        createProtocolIngress({
          app,
          argv: ['C:\\Program Files\\LDB\\ldb.exe'],
          returnTarget
        })
      ).toThrow()

      expect(app.calls).toEqual([])
    }
  )

  it('second-instance malformed 또는 복수 복귀 후보는 auth와 일반 활성화를 모두 거절한다', () => {
    const app = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch, activate)

    app.emit('second-instance', {}, ['electron', `${RETURN_TARGET}?code=short`], '/tmp')
    app.emit('second-instance', {}, ['electron', returnUrl(), returnUrl(OTHER_CODE)], '/tmp')

    expect(dispatch).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
  })

  it('fallback 판별도 protocol 후보가 전혀 없는 second-instance만 일반 실행으로 분류한다', () => {
    const ordinary = isOrdinarySecondInstanceInvocation(['electron', '--new-window'], RETURN_TARGET)
    const validReturn = isOrdinarySecondInstanceInvocation(['electron', returnUrl()], RETURN_TARGET)
    const malformedReturn = isOrdinarySecondInstanceInvocation(
      ['electron', `${RETURN_TARGET}?code=short`],
      RETURN_TARGET
    )
    const multipleReturns = isOrdinarySecondInstanceInvocation(
      ['electron', returnUrl(), returnUrl(OTHER_CODE)],
      RETURN_TARGET
    )
    const wrongScheme = isOrdinarySecondInstanceInvocation(
      ['electron', 'ldb-wrong://auth/return'],
      RETURN_TARGET
    )
    const webUrl = isOrdinarySecondInstanceInvocation(
      ['electron', 'https://example.test/auth/return'],
      RETURN_TARGET
    )
    const paddedWrongScheme = isOrdinarySecondInstanceInvocation(
      ['electron', ' \tldb-wrong://auth/return'],
      RETURN_TARGET
    )
    const malformedScheme = isOrdinarySecondInstanceInvocation(
      ['electron', '1bad://auth/return'],
      RETURN_TARGET
    )
    const singleLetterScheme = isOrdinarySecondInstanceInvocation(
      ['electron', 'x://auth/return'],
      RETURN_TARGET
    )
    const controlPrefixedOpaqueUrl = isOrdinarySecondInstanceInvocation(
      ['electron', '\u0001mailto:user@example.test'],
      RETURN_TARGET
    )
    const internallyPaddedOpaqueUrl = isOrdinarySecondInstanceInvocation(
      ['electron', 'ma\tilto:user@example.test'],
      RETURN_TARGET
    )
    const deletePrefixedOpaqueUrl = isOrdinarySecondInstanceInvocation(
      ['electron', '\u007fmailto:user@example.test'],
      RETURN_TARGET
    )
    const windowsExecutable = isOrdinarySecondInstanceInvocation(
      ['C:\\Program Files\\LDB\\ldb.exe', '--new-window'],
      RETURN_TARGET
    )
    const windowsDriveRelativePath = isOrdinarySecondInstanceInvocation(
      ['electron', 'C:relative-file.txt'],
      RETURN_TARGET
    )

    expect(ordinary).toBe(true)
    expect(validReturn).toBe(false)
    expect(malformedReturn).toBe(false)
    expect(multipleReturns).toBe(false)
    expect(wrongScheme).toBe(false)
    expect(webUrl).toBe(false)
    expect(paddedWrongScheme).toBe(false)
    expect(malformedScheme).toBe(false)
    expect(singleLetterScheme).toBe(false)
    expect(controlPrefixedOpaqueUrl).toBe(false)
    expect(internallyPaddedOpaqueUrl).toBe(false)
    expect(deletePrefixedOpaqueUrl).toBe(false)
    expect(windowsExecutable).toBe(true)
    expect(windowsDriveRelativePath).toBe(false)
  })

  it('일반 활성화 예외를 EventEmitter 밖으로 전파하지 않고 detach 뒤 요청도 하나만 보존한다', () => {
    const app = createApp()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    const firstActivate = vi.fn()
    const detach = ingress.attach(vi.fn(), firstActivate)
    detach()

    app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp')
    app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp')

    const secondActivate = vi.fn(() => {
      throw new Error('activation failed')
    })
    expect(() => ingress.attach(vi.fn(), secondActivate)).not.toThrow()
    expect(secondActivate).toHaveBeenCalledTimes(1)

    expect(() => {
      app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp')
    }).not.toThrow()
    expect(secondActivate).toHaveBeenCalledTimes(2)
    expect(firstActivate).not.toHaveBeenCalled()

    ingress.dispose()
    app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp')
    expect(secondActivate).toHaveBeenCalledTimes(2)
  })

  it('scheme 대소문자 변형도 복귀 후보로 세되 exact parser가 alias를 허용하지 않는다', () => {
    const app = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    const uppercaseScheme = returnUrl().replace('ldb-test:', 'LDB-TEST:')
    ingress.attach(dispatch, activate)

    app.emit('second-instance', {}, ['electron', returnUrl(), uppercaseScheme], '/tmp')
    app.emit('second-instance', {}, ['electron', uppercaseScheme], '/tmp')

    expect(dispatch).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
  })

  it('일반 argv는 창 활성화에만 전달하고 잘못된 복귀 입력은 모두 무시한다', () => {
    const app = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch, activate)

    app.emit('second-instance', {}, ['electron', '--', '/Applications/ldb.app'], '/tmp')
    app.emit('second-instance', {}, ['electron', 'https://example.test'], '/tmp')
    app.emit('second-instance', {}, ['electron', 'ldb-wrong://auth/return'], '/tmp')
    app.emit('second-instance', {}, ['electron', `${RETURN_TARGET}?code=short`], '/tmp')
    app.emit(
      'second-instance',
      {},
      ['electron', `${RETURN_TARGET}?code=${CODE}&state=extra`],
      '/tmp'
    )

    expect(dispatch).not.toHaveBeenCalled()
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('attach 해제 중에는 첫 후보 하나만 보관하고 dispose 뒤 listener와 후보를 정리한다', () => {
    const app = createApp()
    const first = returnUrl()
    const second = returnUrl(OTHER_CODE)
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    const firstDispatch = vi.fn()
    const secondDispatch = vi.fn()
    const detach = ingress.attach(firstDispatch)
    detach()

    const firstEvent = openUrlEvent()
    const secondEvent = openUrlEvent()
    app.emit('open-url', firstEvent, first)
    app.emit('open-url', secondEvent, second)
    ingress.attach(secondDispatch)

    expect(firstEvent.prevented).toBe(true)
    expect(secondEvent.prevented).toBe(true)
    expect(firstDispatch).not.toHaveBeenCalled()
    expect(secondDispatch).toHaveBeenCalledExactlyOnceWith(first)

    ingress.dispose()
    app.emit('open-url', openUrlEvent(), second)
    expect(app.listenerCount('open-url')).toBe(0)
    expect(app.listenerCount('second-instance')).toBe(0)
    expect(secondDispatch).toHaveBeenCalledExactlyOnceWith(first)
  })

  it('정확히 2,048-byte인 복귀는 전달하고 2,049-byte인 복귀는 전달하지 않는다', () => {
    const targetPrefix = 'ldb-test://auth/'
    const exactTarget = `${targetPrefix}${'a'.repeat(1_999 - targetPrefix.length)}`
    const oversizedTarget = `${targetPrefix}${'a'.repeat(2_000 - targetPrefix.length)}`
    const exactRaw = returnUrl(CODE, exactTarget)
    const oversizedRaw = returnUrl(CODE, oversizedTarget)
    const exactApp = createApp()
    const exactDispatch = vi.fn()
    const exactIngress = createProtocolIngress({
      app: exactApp,
      argv: [],
      returnTarget: exactTarget
    })
    exactIngress.attach(exactDispatch)

    exactApp.emit('second-instance', {}, ['electron', exactRaw], '/tmp')

    const oversizedApp = createApp()
    const oversizedDispatch = vi.fn()
    const oversizedIngress = createProtocolIngress({
      app: oversizedApp,
      argv: [],
      returnTarget: oversizedTarget
    })
    oversizedIngress.attach(oversizedDispatch)
    oversizedApp.emit('second-instance', {}, ['electron', oversizedRaw], '/tmp')

    expect(Buffer.byteLength(exactRaw, 'utf8')).toBe(2_048)
    expect(Buffer.byteLength(oversizedRaw, 'utf8')).toBe(2_049)
    expect(exactDispatch).toHaveBeenCalledExactlyOnceWith(exactRaw)
    expect(oversizedDispatch).not.toHaveBeenCalled()
  })

  it('pending 없는 cold 복귀는 coordinator에 전달되지만 로그인 성공을 만들지 않는다', async () => {
    const harness = createAuthHarness()
    const coordinator = createAuthCoordinator(harness.dependencies)
    await coordinator.start()
    const app = createApp()
    const ingress = createProtocolIngress({
      app,
      argv: ['electron', returnUrl()],
      returnTarget: RETURN_TARGET
    })
    const dispatch = vi.fn(coordinator.handleReturnUrl)

    ingress.attach(dispatch)
    await settle()

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(returnUrl())
    expect(coordinator.getSnapshot().phase).toBe('signedOut')
    expect(coordinator.getSnapshot().notice).toBe('LOGIN_RESTART_REQUIRED')
    expect(harness.http.exchange).not.toHaveBeenCalled()
  })

  it('initial restore가 끝난 뒤 buffered cold return을 coordinator에 전달한다', async () => {
    const harness = createAuthHarness()
    const inspection = deferred<Awaited<ReturnType<typeof harness.dependencies.store.inspect>>>()
    harness.store.inspect.mockImplementationOnce(async () => inspection.promise)
    const runtime = await bootstrapAuthRuntime({
      config: runtimeConfig,
      effects: {
        announceCredentialAccess: vi.fn(async () => undefined),
        createDependencies: () => harness.dependencies,
        createSearchClock: () => harness.clock
      }
    })
    if (runtime == null) {
      throw new Error('Synthetic auth runtime should be available')
    }

    const app = createApp()
    const raw = returnUrl()
    const ingress = createProtocolIngress({
      app,
      argv: ['electron', raw],
      returnTarget: RETURN_TARGET
    })
    const start = runtime.start()
    const dispatch = vi.fn((candidate: string) => runtime.coordinator.handleReturnUrl(candidate))
    attachProtocolIngressAfterStart(ingress, start, dispatch)

    expect(dispatch).not.toHaveBeenCalled()
    expect(runtime.coordinator.getSnapshot().phase).toBe('restoring')

    inspection.resolve({ status: 'empty' })
    await start
    await settle()

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(raw)
    expect(runtime.coordinator.getSnapshot().phase).toBe('signedOut')
    expect(runtime.coordinator.getSnapshot().notice).toBe('LOGIN_RESTART_REQUIRED')
    expect(harness.http.exchange).not.toHaveBeenCalled()
  })

  it('start 대기 중 protocol event는 기존 bounded pending 후보 하나만 보존한다', async () => {
    const start = deferred<void>()
    const app = createApp()
    const initial = returnUrl()
    const ingress = createProtocolIngress({
      app,
      argv: ['electron', initial],
      returnTarget: RETURN_TARGET
    })
    const dispatch = vi.fn()

    attachProtocolIngressAfterStart(ingress, start.promise, dispatch)
    app.emit('open-url', openUrlEvent(), returnUrl(OTHER_CODE))
    app.emit('open-url', openUrlEvent(), returnUrl(OTHER_CODE))

    start.resolve()
    await settle()

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(initial)
  })

  it('buffered dispatch가 disposer를 재진입 호출해도 이후 event를 전달하지 않는다', async () => {
    const start = deferred<void>()
    const app = createApp()
    const initial = returnUrl()
    const ingress = createProtocolIngress({
      app,
      argv: ['electron', initial],
      returnTarget: RETURN_TARGET
    })
    const dispatch = vi.fn()
    const stop = attachProtocolIngressAfterStart(ingress, start.promise, (rawReturnUrl) => {
      dispatch(rawReturnUrl)
      stop()
    })

    start.resolve()
    await settle()
    app.emit('open-url', openUrlEvent(), returnUrl(OTHER_CODE))
    await settle()

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(initial)
  })

  it('initial restore 실패 또는 quit 중에는 buffered cold return을 폐기한다', async () => {
    const harness = createAuthHarness()
    const startFailure = deferred<void>()
    const failureApp = createApp()
    const failureIngress = createProtocolIngress({
      app: failureApp,
      argv: ['electron', returnUrl()],
      returnTarget: RETURN_TARGET
    })
    const failureDispatch = vi.fn()
    attachProtocolIngressAfterStart(failureIngress, startFailure.promise, failureDispatch)
    startFailure.reject(new Error('restore failed'))
    await settle()

    expect(failureDispatch).not.toHaveBeenCalled()
    expect(failureApp.listenerCount('open-url')).toBe(0)
    expect(failureApp.listenerCount('second-instance')).toBe(0)

    const inspection = deferred<Awaited<ReturnType<typeof harness.dependencies.store.inspect>>>()
    harness.store.inspect.mockImplementationOnce(async () => inspection.promise)
    const runtime = await bootstrapAuthRuntime({
      config: runtimeConfig,
      effects: {
        announceCredentialAccess: vi.fn(async () => undefined),
        createDependencies: () => harness.dependencies,
        createSearchClock: () => harness.clock
      }
    })
    if (runtime == null) {
      throw new Error('Synthetic auth runtime should be available')
    }
    const quitApp = createApp()
    const quitIngress = createProtocolIngress({
      app: quitApp,
      argv: ['electron', returnUrl()],
      returnTarget: RETURN_TARGET
    })
    const quitDispatch = vi.fn()
    let active = true
    const start = runtime.start()
    const detach = attachProtocolIngressAfterStart(quitIngress, start, quitDispatch, () => active)
    active = false
    detach()
    quitIngress.dispose()

    inspection.resolve({ status: 'empty' })
    await start
    await Promise.resolve()
    expect(quitDispatch).not.toHaveBeenCalled()
    expect(quitApp.listenerCount('open-url')).toBe(0)
    expect(quitApp.listenerCount('second-instance')).toBe(0)
  })
})
