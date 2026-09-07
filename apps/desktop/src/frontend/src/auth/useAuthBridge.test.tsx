// @vitest-environment jsdom
import { act, useEffect, type JSX } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi, type Mocked } from 'vitest'
import type {
  AuthSnapshot,
  AuthCommandResult,
  AuthApi
} from '../../../../preload/common/types/auth'
import { useAuthBridge } from './useAuthBridge'

function snapshot(revision: number, runId = 'run-one'): AuthSnapshot {
  return {
    runId,
    revision,
    phase: 'signedOut',
    providers: ['google'],
    login: null,
    user: null,
    entry: null,
    notice: null
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function createApi(): {
  api: Mocked<AuthApi>
  order: string[]
  listeners: Set<(value: AuthSnapshot) => void>
  retired: ((value: AuthSnapshot) => void)[]
  emit: (value: AuthSnapshot) => void
} {
  const order: string[] = []
  const listeners = new Set<(value: AuthSnapshot) => void>()
  const retired: ((value: AuthSnapshot) => void)[] = []
  const api = {
    getAuthState: vi.fn(async () => {
      order.push('query')
      return snapshot(1)
    }),
    beginLogin: vi.fn<AuthApi['beginLogin']>(async (): Promise<AuthCommandResult> => ({
      ok: true,
      snapshot: snapshot(2)
    })),
    cancelLogin: vi.fn<AuthApi['cancelLogin']>(async (): Promise<AuthCommandResult> => ({
      ok: true,
      snapshot: snapshot(2)
    })),
    retryAuth: vi.fn(async (): Promise<AuthCommandResult> => ({ ok: true, snapshot: snapshot(2) })),
    logout: vi.fn(async (): Promise<AuthCommandResult> => ({ ok: true, snapshot: snapshot(2) })),
    onAuthStateChanged: vi.fn((listener: (value: AuthSnapshot) => void) => {
      order.push('subscribe')
      listeners.add(listener)
      return () => {
        order.push('unsubscribe')
        listeners.delete(listener)
        retired.push(listener)
      }
    })
  }
  return {
    api,
    order,
    listeners,
    retired,
    emit: (value: AuthSnapshot) => listeners.forEach((listener) => listener(value))
  }
}

let root: Root
let container: HTMLDivElement
let fixture: ReturnType<typeof createApi>
let current: ReturnType<typeof useAuthBridge>
function Probe(): JSX.Element {
  const bridge = useAuthBridge(fixture.api)
  useEffect(() => {
    current = bridge
  }, [bridge])
  return <span>{bridge.snapshot?.revision ?? 'disconnected'}</span>
}
async function mount(): Promise<void> {
  await act(async () => root.render(<Probe />))
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  fixture = createApi()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('subscribe 이후 조회하고 먼저 도착한 높은 event revision을 늦은 reply가 덮지 않는다', async () => {
  const query = deferred<AuthSnapshot>()
  fixture.api.getAuthState.mockImplementation(() => {
    fixture.order.push('query')
    return query.promise
  })
  await mount()
  expect(fixture.order).toEqual(['subscribe', 'query'])
  await act(async () => fixture.emit(snapshot(4)))
  await act(async () => query.resolve(snapshot(1)))
  await act(async () => fixture.emit({ ...snapshot(4), notice: 'LOGIN_CANCELLED' }))
  await act(async () => fixture.emit(snapshot(3)))

  expect(current.snapshot).toEqual(snapshot(4))
})

it('commandPending과 exact intent를 전달하고 늦은 command snapshot도 역행하지 않는다', async () => {
  await mount()
  const command = deferred<AuthCommandResult>()
  fixture.api.beginLogin.mockReturnValue(command.promise)
  await act(async () => {
    void current.onIntent({ type: 'beginLogin', provider: 'google' })
  })
  expect(current.commandPending).toBe(true)
  expect(fixture.api.beginLogin).toHaveBeenCalledExactlyOnceWith({ provider: 'google' })
  await act(async () => fixture.emit(snapshot(5)))
  await act(async () => command.resolve({ ok: true, snapshot: snapshot(2) }))

  expect(current.snapshot).toEqual(snapshot(5))
  expect(current.commandPending).toBe(false)
  await act(async () => {
    void current.onIntent({ type: 'cancelLogin', attemptId: 'current-attempt' })
  })
  await act(async () => {
    void current.onIntent({ type: 'retryAuth' })
  })
  await act(async () => {
    void current.onIntent({ type: 'logout' })
  })
  expect(fixture.api.cancelLogin).toHaveBeenCalledExactlyOnceWith({ attemptId: 'current-attempt' })
  expect(fixture.api.retryAuth).toHaveBeenCalledExactlyOnceWith()
  expect(fixture.api.logout).toHaveBeenCalledExactlyOnceWith()
})

it('응답 유실은 snapshot만 재조회하고 mutation을 자동 재전송하지 않는다', async () => {
  await mount()
  fixture.api.logout.mockRejectedValue(new Error('synthetic transport failure'))
  fixture.api.getAuthState.mockResolvedValue(snapshot(6))
  await act(async () => {
    void current.onIntent({ type: 'logout' })
  })

  expect(fixture.api.logout).toHaveBeenCalledTimes(1)
  expect(fixture.api.getAuthState).toHaveBeenCalledTimes(2)
  expect(current.snapshot).toEqual(snapshot(6))
  expect(current.commandPending).toBe(false)
})

it('실패한 bridge 조회는 인증 snapshot을 만들지 않고 연결 실패를 표시한다', async () => {
  fixture.api.getAuthState.mockRejectedValue(new Error('synthetic transport failure'))
  await mount()

  expect(current.snapshot).toBeNull()
  expect(current.connectionFailed).toBe(true)
  expect(fixture.api.getAuthState).toHaveBeenCalledTimes(1)
  expect(fixture.api.beginLogin).not.toHaveBeenCalled()
})

it('runId 변경은 기존 구독을 버리고 새 조회로 기준을 세우며 이전 listener와 reply를 무시한다', async () => {
  await mount()
  const oldCommand = deferred<AuthCommandResult>()
  fixture.api.logout.mockReturnValue(oldCommand.promise)
  await act(async () => {
    void current.onIntent({ type: 'logout' })
  })
  const query = deferred<AuthSnapshot>()
  fixture.api.getAuthState.mockReturnValue(query.promise)
  await act(async () => fixture.emit(snapshot(0, 'run-two')))

  expect(fixture.api.onAuthStateChanged).toHaveBeenCalledTimes(2)
  expect(fixture.api.getAuthState).toHaveBeenCalledTimes(2)
  expect(fixture.listeners.size).toBe(1)
  expect(fixture.retired).toHaveLength(1)
  await act(async () => query.resolve(snapshot(2, 'run-two')))
  await act(async () => fixture.retired[0](snapshot(999)))
  await act(async () => oldCommand.resolve({ ok: true, snapshot: snapshot(1000) }))

  expect(current.snapshot).toEqual(snapshot(2, 'run-two'))
  expect(fixture.api.onAuthStateChanged).toHaveBeenCalledTimes(2)
})

it('unmount은 listener를 해제하고 late query를 버리며 reload는 새 조회를 수행한다', async () => {
  const oldQuery = deferred<AuthSnapshot>()
  fixture.api.getAuthState.mockReturnValueOnce(oldQuery.promise)
  await mount()
  await act(async () => root.unmount())
  expect(fixture.listeners.size).toBe(0)
  root = createRoot(container)
  await mount()
  await act(async () => oldQuery.resolve(snapshot(999)))
  await act(async () => fixture.retired[0](snapshot(1000)))

  expect(current.snapshot).toEqual(snapshot(1))
  expect(fixture.api.getAuthState).toHaveBeenCalledTimes(2)
  expect(fixture.listeners.size).toBe(1)
})
