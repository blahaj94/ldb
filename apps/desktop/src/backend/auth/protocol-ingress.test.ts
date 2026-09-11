import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createAuthCoordinator } from './coordinator'
import {
  createProtocolIngress,
  type ProtocolIngressApp,
  type ProtocolOpenUrlEvent
} from './protocol-ingress'
import { CODE, OTHER_CODE, RETURN_TARGET, createAuthHarness, settle } from './auth-test-fixtures'

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

  it('일반 argv와 잘못된 복귀 입력은 외부 side effect 없이 무시한다', () => {
    const app = createApp()
    const dispatch = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: RETURN_TARGET })
    ingress.attach(dispatch)

    app.emit(
      'second-instance',
      {},
      ['electron', '--', '/Applications/ldb.app', 'https://example.test'],
      '/tmp'
    )
    app.emit('second-instance', {}, ['electron', `${RETURN_TARGET}?code=short`], '/tmp')
    app.emit(
      'second-instance',
      {},
      ['electron', `${RETURN_TARGET}?code=${CODE}&state=extra`],
      '/tmp'
    )

    expect(dispatch).not.toHaveBeenCalled()
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
    const app = createApp()
    const dispatch = vi.fn()
    const ingress = createProtocolIngress({ app, argv: [], returnTarget: exactTarget })
    ingress.attach(dispatch)

    app.emit('second-instance', {}, ['electron', exactRaw], '/tmp')
    app.emit('second-instance', {}, ['electron', oversizedRaw], '/tmp')

    expect(Buffer.byteLength(exactRaw, 'utf8')).toBe(2_048)
    expect(Buffer.byteLength(oversizedRaw, 'utf8')).toBe(2_049)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(exactRaw)
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
})
