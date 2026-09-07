import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthCoordinator } from './coordinator'
import { registerAuthIpc } from './ipc-handler'
import { ATTEMPT_ID, CODE, RETURN_TARGET, createAuthHarness, deferred } from './auth-test-fixtures'
import type { AuthCommandResult, AuthSnapshot, AuthCoordinator } from './types'

const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: electron }))

const DOCUMENT_URL = 'file:///fixture/index.html'
const CHANNELS = ['getAuthState', 'beginLogin', 'cancelLogin', 'retryAuth', 'logout']
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

type FixtureFrame = { url: string; detached: boolean }
type FixtureContents = {
  mainFrame: FixtureFrame
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>
  send: ReturnType<typeof vi.fn>
}
type IpcFixture = {
  effects: ReturnType<typeof createAuthHarness>
  coordinator: AuthCoordinator
  frame: FixtureFrame
  contents: FixtureContents
  window: { webContents: FixtureContents; isDestroyed: ReturnType<typeof vi.fn<() => boolean>> }
  event: IpcMainInvokeEvent
  dispose: () => void
  invoke: (channel: string, args?: unknown[], sender?: IpcMainInvokeEvent) => Promise<unknown>
  replaceWindow: () => void
}

async function setup(): Promise<IpcFixture> {
  const effects = createAuthHarness()
  const coordinator = createAuthCoordinator(effects.dependencies)
  await coordinator.start()
  effects.operations.length = 0
  const frame = { url: DOCUMENT_URL, detached: false }
  const contents = { mainFrame: frame, isDestroyed: vi.fn(() => false), send: vi.fn() }
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) }
  // Electron identity만 대체하며 coordinator와 effect orchestration은 실제 구현을 사용한다.
  let currentWindow = window as unknown as BrowserWindow | null
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const dispose = registerAuthIpc({
    coordinator,
    getWindow: () => currentWindow,
    documentUrl: DOCUMENT_URL
  })
  const handlers = new Map<string, Handler>(
    electron.handle.mock.calls.map(([channel, handler]) => [channel, handler])
  )
  function invoke(channel: string, args: unknown[] = [], sender = event): Promise<unknown> {
    const handler = handlers.get(channel)
    const hasHandler = handler != null
    if (!hasHandler) throw new Error('Expected registered auth handler')
    return Promise.resolve().then(() => handler(sender, ...args))
  }
  return {
    effects,
    coordinator,
    frame,
    contents,
    window,
    event,
    dispose,
    invoke,
    replaceWindow: () => {
      currentWindow = null
    }
  }
}

beforeEach(() => vi.clearAllMocks())

describe('auth IPC trust boundary', () => {
  it('5 invoke만 등록하며 local snapshot 조회는 effect가 없다', async () => {
    const fixture = await setup()

    expect(electron.handle.mock.calls.map(([channel]) => channel)).toEqual(CHANNELS)
    await expect(fixture.invoke('getAuthState')).resolves.toEqual(fixture.coordinator.getSnapshot())
    expect(fixture.effects.operations).toEqual([])
    fixture.dispose()
    expect(electron.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(CHANNELS)
  })

  it.each([
    'other-sender',
    'subframe',
    'null-frame',
    'detached',
    'destroyed',
    'no-window',
    'navigation',
    'prefix-url'
  ])('%s sender는 모든 invoke에서 snapshot 없는 rejection이고 effect 0이다', async (kind) => {
    const fixture = await setup()
    const invalidEvent = { ...fixture.event }
    const isOtherSender = kind === 'other-sender'
    if (isOtherSender) invalidEvent.sender = {} as IpcMainInvokeEvent['sender']
    const isSubframe = kind === 'subframe'
    if (isSubframe)
      invalidEvent.senderFrame = { ...fixture.frame } as IpcMainInvokeEvent['senderFrame']
    const isNullFrame = kind === 'null-frame'
    if (isNullFrame) invalidEvent.senderFrame = null
    const isDetached = kind === 'detached'
    if (isDetached) fixture.frame.detached = true
    const isDestroyed = kind === 'destroyed'
    if (isDestroyed) fixture.contents.isDestroyed.mockReturnValue(true)
    const hasNoWindow = kind === 'no-window'
    if (hasNoWindow) fixture.replaceWindow()
    const isNavigation = kind === 'navigation'
    if (isNavigation) fixture.frame.url = 'about:blank'
    const isPrefixUrl = kind === 'prefix-url'
    if (isPrefixUrl) fixture.frame.url = `${DOCUMENT_URL}.untrusted`
    const initial = fixture.coordinator.getSnapshot()

    for (const channel of CHANNELS) {
      await expect(fixture.invoke(channel, [], invalidEvent)).rejects.toThrow(/^AUTH_NOT_ALLOWED$/)
    }
    expect(fixture.coordinator.getSnapshot()).toEqual(initial)
    expect(fixture.effects.operations).toEqual([])
    expect(fixture.contents.send).not.toHaveBeenCalled()
  })

  it('getAuthState의 추가 인자는 정제 rejection이며 snapshot과 effect를 바꾸지 않는다', async () => {
    const fixture = await setup()
    const initial = fixture.coordinator.getSnapshot()

    await expect(fixture.invoke('getAuthState', [undefined])).rejects.toThrow(
      /^INVALID_AUTH_COMMAND$/
    )
    expect(fixture.effects.operations).toEqual([])
    expect(fixture.coordinator.getSnapshot()).toEqual(initial)
  })

  it.each([
    ['retryAuth', [{}]],
    ['logout', [null]],
    ['beginLogin', []],
    ['beginLogin', [null]],
    ['beginLogin', [[]]],
    ['beginLogin', [{ provider: 'google' }, undefined]],
    ['beginLogin', [{ provider: 'google', url: 'https://example.test' }]],
    ['beginLogin', [{ provider: 'GOOGLE' }]],
    ['beginLogin', [{ provider: 1 }]],
    ['beginLogin', [Object.create({ provider: 'google' })]],
    ['cancelLogin', [{ attemptId: 'invalid' }]],
    ['cancelLogin', [{ attemptId: ATTEMPT_ID, code: 'unexpected' }]],
    ['cancelLogin', [{ attemptId: 'a'.repeat(4096) }]]
  ])('%s rejects malformed exact arguments', async (channel, args) => {
    const fixture = await setup()
    const initial = fixture.coordinator.getSnapshot()

    await expect(fixture.invoke(channel as string, args as unknown[])).resolves.toEqual({
      ok: false,
      error: { code: 'INVALID_AUTH_COMMAND' },
      snapshot: initial
    })
    expect(fixture.effects.operations).toEqual([])
    expect(fixture.coordinator.getSnapshot()).toEqual(initial)
  })

  it('real core의 begin/cancel/exchange/logout 결과와 정제 snapshot event를 전달한다', async () => {
    const fixture = await setup()
    const begin = (await fixture.invoke('beginLogin', [
      { provider: 'google' }
    ])) as AuthCommandResult
    expect(begin).toMatchObject({ ok: true, snapshot: { phase: 'startingLogin' } })
    await vi.waitFor(() => expect(fixture.coordinator.getSnapshot().phase).toBe('waitingBrowser'))
    const cancel = await fixture.invoke('cancelLogin', [{ attemptId: ATTEMPT_ID }])
    expect(cancel).toMatchObject({
      ok: true,
      snapshot: { phase: 'signedOut', notice: 'LOGIN_CANCELLED' }
    })
    await fixture.invoke('beginLogin', [{ provider: 'discord' }])
    await vi.waitFor(() => expect(fixture.coordinator.getSnapshot().phase).toBe('waitingBrowser'))
    await fixture.coordinator.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    await expect(fixture.invoke('getAuthState')).resolves.toMatchObject({
      phase: 'signedIn',
      entry: 'welcome'
    })
    await expect(fixture.invoke('logout')).resolves.toMatchObject({
      ok: true,
      snapshot: { phase: 'signedOut' }
    })

    expect(fixture.effects.http.exchange).toHaveBeenCalledTimes(1)
    expect(fixture.effects.http.logout).toHaveBeenCalledTimes(1)
    for (const [channel, snapshot] of fixture.contents.send.mock.calls as [
      string,
      AuthSnapshot
    ][]) {
      expect(channel).toBe('authStateChanged')
      expect(Object.keys(snapshot).sort()).toEqual([
        'entry',
        'login',
        'notice',
        'phase',
        'providers',
        'revision',
        'runId',
        'user'
      ])
      const hasLogin = snapshot.login != null
      if (hasLogin)
        expect(Object.keys(snapshot.login!).sort()).toEqual(['attemptId', 'expiresAt', 'provider'])
      const hasUser = snapshot.user != null
      if (hasUser) expect(Object.keys(snapshot.user!)).toEqual(['nickname'])
    }
    expect(fixture.contents.send).toHaveBeenCalled()
  })

  it('현재 attempt의 busy와 stale 결과를 그대로 유지한다', async () => {
    const fixture = await setup()
    await fixture.invoke('beginLogin', [{ provider: 'google' }])
    await vi.waitFor(() => expect(fixture.coordinator.getSnapshot().phase).toBe('waitingBrowser'))
    const initial = fixture.coordinator.getSnapshot()
    fixture.effects.operations.length = 0

    await expect(fixture.invoke('beginLogin', [{ provider: 'discord' }])).resolves.toEqual({
      ok: false,
      error: { code: 'AUTH_BUSY' },
      snapshot: initial
    })
    await expect(
      fixture.invoke('cancelLogin', [{ attemptId: '00000000-0000-4000-8000-000000000099' }])
    ).resolves.toEqual({
      ok: false,
      error: { code: 'STALE_ATTEMPT' },
      snapshot: initial
    })
    expect(fixture.effects.operations).toEqual([])
    expect(fixture.coordinator.getSnapshot()).toEqual(initial)
  })

  it('command exception은 raw error 대신 정제된 결과로 반환한다', async () => {
    const fixture = await setup()
    vi.spyOn(fixture.coordinator, 'logout').mockRejectedValue(
      new Error('synthetic internal failure')
    )

    await expect(fixture.invoke('logout')).resolves.toEqual({
      ok: false,
      error: { code: 'AUTH_OPERATION_FAILED' },
      snapshot: fixture.coordinator.getSnapshot()
    })
  })

  it('navigation 뒤 publication과 늦은 command reply를 새 document에 넘기지 않는다', async () => {
    const fixture = await setup()
    const result = deferred<AuthCommandResult>()
    vi.spyOn(fixture.coordinator, 'logout').mockReturnValue(result.promise)
    const reply = fixture.invoke('logout')
    await Promise.resolve()
    fixture.frame.url = 'about:blank'
    result.resolve({ ok: true, snapshot: fixture.coordinator.getSnapshot() })

    await expect(reply).rejects.toThrow(/^AUTH_NOT_ALLOWED$/)
    await fixture.coordinator.beginLogin('google')
    expect(fixture.contents.send).not.toHaveBeenCalled()
  })

  it('dispose 뒤 core publication이 listener에 남지 않는다', async () => {
    const fixture = await setup()
    fixture.dispose()
    await fixture.coordinator.beginLogin('google')

    expect(fixture.contents.send).not.toHaveBeenCalled()
  })
})
