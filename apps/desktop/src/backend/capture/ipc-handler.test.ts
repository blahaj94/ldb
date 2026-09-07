import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthCoordinator } from '../auth/coordinator'
import {
  createAuthHarness,
  deferred,
  REFRESH_0,
  CODE,
  RETURN_TARGET
} from '../auth/auth-test-fixtures'
import { registerCaptureIpc, registerCaptureWindow } from './ipc-handler'

const electron = vi.hoisted(() => ({ getSources: vi.fn(), handle: vi.fn() }))
vi.mock('electron', () => ({
  desktopCapturer: { getSources: electron.getSources },
  ipcMain: { handle: electron.handle }
}))

const rendererUrl = 'file:///fixture/index.html'
const sources = [{ id: 'window:fixture', name: 'Synthetic capture window' }]
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type MediaHandler = (
  request: Electron.DisplayMediaRequest,
  callback: (result: unknown) => void
) => void

async function setup(signedIn = true): Promise<{
  auth: ReturnType<typeof createAuthCoordinator>
  harness: ReturnType<typeof createAuthHarness>
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  event: IpcMainInvokeEvent
  mainFrame: { url: string; isDestroyed: () => boolean }
  requestMedia: (changes?: Partial<Electron.DisplayMediaRequest>) => Promise<unknown>
}> {
  const harness = createAuthHarness()
  if (signedIn) harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
  const auth = createAuthCoordinator(harness.dependencies)
  await auth.start()
  harness.http.refresh.mockClear()
  let mediaHandler: MediaHandler | undefined
  const mainFrame = { url: rendererUrl, isDestroyed: () => false }
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
    session: {
      setDisplayMediaRequestHandler: (handler: MediaHandler) => {
        mediaHandler = handler
      }
    }
  }
  const window = { webContents, isDestroyed: () => false, on: vi.fn() }
  // 기존 entry의 허용 인자만 확장하며 테스트에서 실제 coordinator를 전달한다.
  Reflect.apply(registerCaptureIpc, undefined, [auth])
  Reflect.apply(registerCaptureWindow, undefined, [window as unknown as BrowserWindow, rendererUrl])
  const handlers = new Map<string, Handler>()
  for (const [channel, handler] of electron.handle.mock.calls) handlers.set(channel, handler)
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)
    const hasHandler = handler != null
    if (!hasHandler) throw new Error('Capture handler was not registered')
    return Promise.resolve().then(() => handler(event, ...args))
  }
  const requestMedia = (changes: Partial<Electron.DisplayMediaRequest> = {}): Promise<unknown> => {
    const request = {
      frame: mainFrame,
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
      ...changes
    }
    return new Promise<unknown>((resolve) =>
      mediaHandler?.(request as Electron.DisplayMediaRequest, resolve)
    )
  }
  return { auth, harness, invoke, event, mainFrame, requestMedia }
}

beforeEach(() => {
  vi.clearAllMocks()
  electron.getSources.mockResolvedValue(sources)
})
afterEach(() => vi.restoreAllMocks())

describe('capture main auth boundary', () => {
  it('signedOut에서는 source 열거·선택을 거절하고 빈 선택 cleanup은 허용한다', async () => {
    const fixture = await setup(false)
    await expect(fixture.invoke('listCaptureSources')).rejects.toThrow()
    await expect(fixture.invoke('selectCaptureSource', sources[0].id)).rejects.toThrow()
    await expect(fixture.invoke('selectCaptureSource', '')).resolves.toBeNull()
    expect(electron.getSources).not.toHaveBeenCalled()
  })

  it.each(['listCaptureSources', 'selectCaptureSource'])(
    '%s 완료 전 logout이면 결과를 허용하지 않는다',
    async (channel) => {
      const fixture = await setup()
      const pending = deferred<typeof sources>()
      electron.getSources.mockReturnValue(pending.promise)
      const isSelection = channel === 'selectCaptureSource'
      const operation = fixture.invoke(channel, ...(isSelection ? [sources[0].id] : []))
      const rejection = expect(operation).rejects.toThrow()
      await Promise.resolve()
      await fixture.auth.logout()
      pending.resolve(sources)
      await rejection
    }
  )

  it('이전 auth 수명의 열거는 logout과 재로그인 뒤에도 거절한다', async () => {
    const fixture = await setup()
    const pending = deferred<typeof sources>()
    electron.getSources.mockReturnValue(pending.promise)
    const operation = fixture.invoke('listCaptureSources')
    const rejection = expect(operation).rejects.toThrow()
    await Promise.resolve()
    await fixture.auth.logout()
    await fixture.auth.beginLogin('google')
    await vi.waitFor(() => expect(fixture.auth.getSnapshot().phase).toBe('waitingBrowser'))
    await fixture.auth.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    expect(fixture.auth.getSnapshot().phase).toBe('signedIn')
    pending.resolve(sources)
    await rejection
    expect(await fixture.requestMedia()).toEqual({})
  })

  it.each(['subframe', 'document'])(
    'trusted window라도 %s 변경 뒤 source 요청은 거절한다',
    async (kind) => {
      const fixture = await setup()
      const isSubframe = kind === 'subframe'
      if (isSubframe) Object.assign(fixture.event, { senderFrame: { url: rendererUrl } })
      else fixture.mainFrame.url = `${rendererUrl}?unexpected`
      await expect(fixture.invoke('listCaptureSources')).rejects.toThrow()
      expect(electron.getSources).not.toHaveBeenCalled()
    }
  )

  it.each(['listCaptureSources', 'selectCaptureSource'])(
    '%s 완료 전 document 변경이면 거절한다',
    async (channel) => {
      const fixture = await setup()
      const pending = deferred<typeof sources>()
      electron.getSources.mockReturnValue(pending.promise)
      const isSelection = channel === 'selectCaptureSource'
      const operation = fixture.invoke(channel, ...(isSelection ? [sources[0].id] : []))
      const rejection = expect(operation).rejects.toThrow()
      await Promise.resolve()
      fixture.mainFrame.url = 'about:blank'
      pending.resolve(sources)
      await rejection
    }
  )

  it('trusted renderer의 빈 선택도 subframe에서는 cleanup을 허용하지 않는다', async () => {
    const fixture = await setup(false)
    Object.assign(fixture.event, { senderFrame: { url: rendererUrl } })
    await expect(fixture.invoke('selectCaptureSource', '')).rejects.toThrow()
  })

  it.each([
    { userGesture: false },
    { audioRequested: true },
    { videoRequested: false },
    { frame: null }
  ])('기존 media 조건 위반 %j는 계속 거절한다', async (changes) => {
    const fixture = await setup()
    await fixture.invoke('selectCaptureSource', sources[0].id)
    expect(await fixture.requestMedia(changes)).toEqual({})
  })

  it('선택 뒤 logout은 main source를 지우고 media를 거절한다', async () => {
    const fixture = await setup()
    await fixture.invoke('selectCaptureSource', sources[0].id)
    await fixture.auth.logout()
    expect(await fixture.requestMedia()).toEqual({})
  })

  it.each(['logout', 'clear', 'document'])(
    'media 열거 중 %s이면 늦은 stream을 허용하지 않는다',
    async (kind) => {
      const fixture = await setup()
      await fixture.invoke('selectCaptureSource', sources[0].id)
      const pending = deferred<typeof sources>()
      electron.getSources.mockReturnValue(pending.promise)
      const media = fixture.requestMedia()
      const isLogout = kind === 'logout'
      const isClear = kind === 'clear'
      if (isLogout) await fixture.auth.logout()
      else if (isClear) await fixture.invoke('selectCaptureSource', '')
      else fixture.mainFrame.url = 'about:blank'
      pending.resolve(sources)
      expect(await media).toEqual({})
    }
  )

  it('capture 조회·선택·media는 HTTP refresh 없이 실행하고 raw OCR를 log하지 않는다', async () => {
    const fixture = await setup()
    fixture.harness.clock.elapseWithoutTimers(16 * 60 * 1000)
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await fixture.invoke('listCaptureSources')
    await fixture.invoke('selectCaptureSource', sources[0].id)
    expect(await fixture.requestMedia()).toEqual({ video: sources[0] })
    await fixture.invoke('notifyStableNicknameDetected', { slot: 0, nickname: 'SYNTHETIC_CANARY' })
    expect(fixture.harness.http.refresh).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})
