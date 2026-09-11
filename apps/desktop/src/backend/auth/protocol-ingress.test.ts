import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { bootstrapAuthRuntime } from './bootstrap'
import { createAuthCoordinator } from './coordinator'
import {
  attachProtocolIngressAfterStart,
  createProtocolIngress,
  isOrdinarySecondInstanceInvocation as classifyOrdinarySecondInstanceInvocation,
  selectProtocolIngressArguments,
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
  lockData: unknown

  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean {
    this.calls.push('requestSingleInstanceLock')
    this.lockData = additionalData
    return this.lockResult
  }

  quit(): void {
    this.calls.push('quit')
  }
}

function createApp(): FakeApp & ProtocolIngressApp {
  return new FakeApp() as FakeApp & ProtocolIngressApp
}

function createHandoff(argv: readonly unknown[], returnTarget: string = RETURN_TARGET): unknown {
  const secondary = createApp()
  secondary.lockResult = false
  createProtocolIngress({ app: secondary, argv, returnTarget })
  return secondary.lockData
}

function emitSecondInstance(
  app: FakeApp,
  argv: readonly unknown[],
  returnTarget: string = RETURN_TARGET
): void {
  app.emit(
    'second-instance',
    {},
    ['electron', '--chromium-added'],
    '/tmp',
    createHandoff(argv, returnTarget)
  )
}

function isOrdinarySecondInstanceInvocation(
  values: readonly unknown[],
  returnTarget: string
): boolean {
  return classifyOrdinarySecondInstanceInvocation(createHandoff(values, returnTarget), returnTarget)
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

    emitSecondInstance(app, ['--user-data-dir=/tmp/profile', returnUrl(), returnUrl(OTHER_CODE)])

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('second-instance 일반 실행은 start 뒤 창을 활성화하고 start 전 반복 요청은 하나로 제한한다', async () => {
    const start = deferred<void>()
    const app = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })

    attachProtocolIngressAfterStart(ingress, start.promise, dispatch, () => true, activate)
    emitSecondInstance(app, ['--new-window'])
    emitSecondInstance(app, ['--new-window'])

    expect(dispatch).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()

    start.resolve()
    await settle()

    expect(dispatch).not.toHaveBeenCalled()
    expect(activate).toHaveBeenCalledTimes(1)

    emitSecondInstance(app, ['--new-window'])
    await settle()

    expect(activate).toHaveBeenCalledTimes(2)
  })

  it('second-instance exact 복귀는 auth에만 전달하고 일반 활성화를 실행하지 않는다', () => {
    const app = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch, activate)

    emitSecondInstance(app, [returnUrl()])

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(returnUrl())
    expect(activate).not.toHaveBeenCalled()
  })

  it('second-instance는 Chromium이 바꿀 수 있는 commandLine 대신 bounded handoff argv를 판정한다', () => {
    const owner = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app: owner, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch, activate)
    const secondary = createApp()
    secondary.lockResult = false
    createProtocolIngress({ app: secondary, argv: [returnUrl()], returnTarget: RETURN_TARGET })

    owner.emit(
      'second-instance',
      {},
      ['--original-process-start-time=changed', 'https://chromium-added.invalid'],
      '/tmp',
      secondary.lockData
    )

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(returnUrl())
    expect(activate).not.toHaveBeenCalled()
  })

  it('bounded handoff의 일반 colon 인자는 활성화하고 변형 commandLine URL은 판정에 쓰지 않는다', () => {
    const owner = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app: owner, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch, activate)
    const secondary = createApp()
    secondary.lockResult = false
    createProtocolIngress({
      app: secondary,
      argv: ['/tmp/report:2026.txt', '--label=12:30', 'meeting at: noon'],
      returnTarget: RETURN_TARGET
    })

    owner.emit(
      'second-instance',
      {},
      ['https://chromium-added.invalid'],
      '/tmp',
      secondary.lockData
    )

    expect(dispatch).not.toHaveBeenCalled()
    expect(activate).toHaveBeenCalledOnce()
  })

  it('누락되거나 malformed인 second-instance handoff는 commandLine이 평범해도 fail closed한다', () => {
    const app = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch, activate)

    app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp', undefined)
    app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp', {
      version: 1,
      argv: 'not-an-array'
    })
    app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp', {
      version: 1,
      argv: ['--new-window'],
      extra: true
    })
    app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp', {
      version: 2,
      argv: ['--new-window']
    })
    app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp', {
      version: 1,
      argv: ['--new-window', 1]
    })

    expect(dispatch).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
  })

  it('second-instance handoff의 count, argument와 total byte 상한을 exact 경계에서 강제한다', () => {
    const observe = (argv: readonly string[]): ReturnType<typeof vi.fn> => {
      const app = createApp()
      const activate = vi.fn()
      const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
      ingress.attach(vi.fn(), activate)
      emitSecondInstance(app, argv)
      return activate
    }

    expect(observe(Array.from({ length: 64 }, () => 'arg'))).toHaveBeenCalledOnce()
    expect(observe(Array.from({ length: 65 }, () => 'arg'))).not.toHaveBeenCalled()
    expect(observe(['é'.repeat(2_048)])).toHaveBeenCalledOnce()
    expect(observe(['é'.repeat(2_049)])).not.toHaveBeenCalled()
    expect(observe(['a'.repeat(4_097)])).not.toHaveBeenCalled()
    expect(observe(Array.from({ length: 4 }, () => 'é'.repeat(2_048)))).toHaveBeenCalledOnce()
    expect(
      observe([...Array.from({ length: 4 }, () => 'é'.repeat(2_048)), 'é'])
    ).not.toHaveBeenCalled()
    expect(
      observe([...Array.from({ length: 4 }, () => 'a'.repeat(4_096)), 'a'])
    ).not.toHaveBeenCalled()
  })

  it.each(['count', 'argument', 'total'] as const)(
    'owner는 직접 받은 %s 초과 handoff도 다시 검증해 fail closed한다',
    (kind) => {
      const app = createApp()
      const dispatch = vi.fn()
      const activate = vi.fn()
      const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
      ingress.attach(dispatch, activate)
      const argv =
        kind === 'count'
          ? Array.from({ length: 65 }, () => 'arg')
          : kind === 'argument'
            ? ['a'.repeat(4_097)]
            : [...Array.from({ length: 4 }, () => 'a'.repeat(4_096)), 'a']

      app.emit('second-instance', {}, ['electron', '--new-window'], '/tmp', {
        version: 1,
        argv
      })

      expect(dispatch).not.toHaveBeenCalled()
      expect(activate).not.toHaveBeenCalled()
    }
  )

  it.each(['count', 'argument', 'total'] as const)(
    '초기 user argv의 %s 상한 초과는 유효 callback이 섞여도 전달하지 않는다',
    (kind) => {
      const raw = returnUrl()
      const totalOverflowTailBytes = 16_385 - Buffer.byteLength(raw, 'utf8') - 3 * 4_096
      const argv =
        kind === 'count'
          ? [...Array.from({ length: 64 }, () => 'arg'), raw]
          : kind === 'argument'
            ? [raw, 'a'.repeat(4_097)]
            : [
                raw,
                ...Array.from({ length: 3 }, () => 'a'.repeat(4_096)),
                'a'.repeat(totalOverflowTailBytes)
              ]
      const app = createApp()
      const dispatch = vi.fn()

      const ingress = createProtocolIngress({ app, argv, returnTarget: RETURN_TARGET })
      ingress.attach(dispatch)

      expect(dispatch).not.toHaveBeenCalled()
    }
  )

  it.each(['c://auth/return', 'c:/auth/return', 'c:opaque-return'])(
    'one-letter private scheme %s도 기존 exact callback 계약대로 전달한다',
    (returnTarget) => {
      const app = createApp()
      const raw = returnUrl(CODE, returnTarget)
      const dispatch = vi.fn()

      const ingress = createProtocolIngress({ app, argv: [raw], returnTarget })
      ingress.attach(dispatch)

      expect(app.calls).toEqual(['requestSingleInstanceLock'])
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(raw)
    }
  )

  it('second-instance malformed 또는 복수 복귀 후보는 auth와 일반 활성화를 모두 거절한다', () => {
    const app = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch, activate)

    emitSecondInstance(app, [`${RETURN_TARGET}?code=short`])
    emitSecondInstance(app, [returnUrl(), returnUrl(OTHER_CODE)])

    expect(dispatch).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
  })

  it.each([
    '1bad:/auth/return',
    '+bad:/auth/return',
    '--return-url=1bad:/auth/return',
    '1bad:////auth/return',
    String.raw`1bad:\auth\return`,
    String.raw`:\auth\return`,
    String.raw`--return-url=1bad:\auth\return`
  ])('malformed hierarchical URL-like 입력 %s은 일반 실행으로 활성화하지 않는다', (value) => {
    const app = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch, activate)

    emitSecondInstance(app, [value])

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
    const noBreakSpacePrefixedOpaqueUrl = isOrdinarySecondInstanceInvocation(
      ['electron', '\u00a0mailto:user@example.test'],
      RETURN_TARGET
    )
    const internallyControlledOpaqueUrl = isOrdinarySecondInstanceInvocation(
      ['electron', 'ma\u0000ilto:user@example.test'],
      RETURN_TARGET
    )
    const missingScheme = isOrdinarySecondInstanceInvocation(
      ['electron', '://auth/return'],
      RETURN_TARGET
    )
    const windowsAbsolutePath = isOrdinarySecondInstanceInvocation(
      ['electron', 'C:\\Users\\Alice\\report.txt'],
      RETURN_TARGET
    )
    const windowsDriveRelativePath = isOrdinarySecondInstanceInvocation(
      ['electron', 'C:relative-file.txt'],
      RETURN_TARGET
    )
    const colonBearingOrdinaryArguments = isOrdinarySecondInstanceInvocation(
      [
        'electron',
        '/tmp/report:2026.txt',
        '/tmp/report:/2026.txt',
        String.raw`/tmp/report:\2026.txt`,
        '--path=/tmp/report:/2026',
        '--label=12:30',
        'meeting at: noon'
      ],
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
    expect(noBreakSpacePrefixedOpaqueUrl).toBe(false)
    expect(internallyControlledOpaqueUrl).toBe(false)
    expect(missingScheme).toBe(false)
    expect(windowsAbsolutePath).toBe(false)
    expect(windowsDriveRelativePath).toBe(false)
    expect(colonBearingOrdinaryArguments).toBe(true)
  })

  it('packaged와 Electron defaultApp bootstrap argv를 user handoff에서 제거한다', () => {
    const executable = 'C:\\Program Files\\Electron\\electron.exe'
    const appPath = 'C:\\workspace\\ldb'
    const callback = returnUrl()

    expect(selectProtocolIngressArguments([executable, callback], false)).toEqual([callback])
    expect(selectProtocolIngressArguments([executable, appPath, callback], true)).toEqual([
      callback
    ])

    const owner = createApp()
    const dispatch = vi.fn()
    const ingress = createProtocolIngress({ app: owner, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch)
    const secondary = createApp()
    secondary.lockResult = false
    createProtocolIngress({
      app: secondary,
      argv: selectProtocolIngressArguments([executable, appPath, callback], true),
      returnTarget: RETURN_TARGET
    })
    owner.emit('second-instance', {}, [appPath, executable, callback], '/tmp', secondary.lockData)

    expect(dispatch).toHaveBeenCalledExactlyOnceWith(callback)
  })

  it('일반 활성화 예외를 EventEmitter 밖으로 전파하지 않고 detach 뒤 요청도 하나만 보존한다', () => {
    const app = createApp()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    const firstActivate = vi.fn()
    const detach = ingress.attach(vi.fn(), firstActivate)
    detach()

    emitSecondInstance(app, ['--new-window'])
    emitSecondInstance(app, ['--new-window'])

    const secondActivate = vi.fn(() => {
      throw new Error('activation failed')
    })
    expect(() => ingress.attach(vi.fn(), secondActivate)).not.toThrow()
    expect(secondActivate).toHaveBeenCalledTimes(1)

    expect(() => {
      emitSecondInstance(app, ['--new-window'])
    }).not.toThrow()
    expect(secondActivate).toHaveBeenCalledTimes(2)
    expect(firstActivate).not.toHaveBeenCalled()

    ingress.dispose()
    emitSecondInstance(app, ['--new-window'])
    expect(secondActivate).toHaveBeenCalledTimes(2)
  })

  it('scheme 대소문자 변형도 복귀 후보로 세되 exact parser가 alias를 허용하지 않는다', () => {
    const app = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    const uppercaseScheme = returnUrl().replace('ldb-test:', 'LDB-TEST:')
    ingress.attach(dispatch, activate)

    emitSecondInstance(app, [returnUrl(), uppercaseScheme])
    emitSecondInstance(app, [uppercaseScheme])

    expect(dispatch).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
  })

  it('일반 argv는 창 활성화에만 전달하고 잘못된 복귀 입력은 모두 무시한다', () => {
    const app = createApp()
    const dispatch = vi.fn()
    const activate = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch, activate)

    emitSecondInstance(app, ['--', '/Applications/ldb.app'])
    emitSecondInstance(app, ['https://example.test'])
    emitSecondInstance(app, ['ldb-wrong://auth/return'])
    emitSecondInstance(app, [`${RETURN_TARGET}?code=short`])
    emitSecondInstance(app, [`${RETURN_TARGET}?code=${CODE}&state=extra`])

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

    emitSecondInstance(exactApp, [exactRaw], exactTarget)

    const oversizedApp = createApp()
    const oversizedDispatch = vi.fn()
    const oversizedIngress = createProtocolIngress({
      app: oversizedApp,
      argv: [],
      returnTarget: oversizedTarget
    })
    oversizedIngress.attach(oversizedDispatch)
    emitSecondInstance(oversizedApp, [oversizedRaw], oversizedTarget)

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
