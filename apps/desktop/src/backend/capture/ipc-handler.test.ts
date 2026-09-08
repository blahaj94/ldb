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
  request: Electron.DisplayMediaRequestHandlerHandlerRequest,
  callback: (result: unknown) => void
) => void

async function setup(signedIn = true): Promise<{
  auth: ReturnType<typeof createAuthCoordinator>
  harness: ReturnType<typeof createAuthHarness>
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  event: IpcMainInvokeEvent
  mainFrame: { url: string; isDestroyed: () => boolean }
  dispatchMedia: (callback: (result: unknown) => void) => void
  requestMedia: (
    changes?: Partial<Electron.DisplayMediaRequestHandlerHandlerRequest>
  ) => Promise<unknown>
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
    on: vi.fn(),
    send: vi.fn(),
    isDestroyed: () => false,
    session: {
      setDisplayMediaRequestHandler: (handler: MediaHandler) => {
        mediaHandler = handler
      }
    }
  }
  const window = { webContents, isDestroyed: () => false, on: vi.fn() }
  // 기존 entry의 허용 인자만 확장하며 테스트에서 실제 coordinator를 전달한다.
  registerCaptureIpc(auth)
  registerCaptureWindow(window as unknown as BrowserWindow, rendererUrl)
  const handlers = new Map<string, Handler>()
  for (const [channel, handler] of electron.handle.mock.calls) handlers.set(channel, handler)
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)
    expect(handler, `등록된 ${channel} IPC가 요청을 처리해야 한다`).toBeTypeOf('function')
    const hasHandler = handler != null
    if (!hasHandler) throw new Error('Capture handler was not registered')
    return Promise.resolve().then(() => handler(event, ...args))
  }
  const dispatchMedia = (
    callback: (result: unknown) => void,
    changes: Partial<Electron.DisplayMediaRequestHandlerHandlerRequest> = {}
  ): void => {
    const request = {
      frame: mainFrame,
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
      ...changes
    }
    mediaHandler?.(request as Electron.DisplayMediaRequestHandlerHandlerRequest, callback)
  }
  const requestMedia = (
    changes: Partial<Electron.DisplayMediaRequestHandlerHandlerRequest> = {}
  ): Promise<unknown> => new Promise((resolve) => dispatchMedia(resolve, changes))
  return { auth, harness, invoke, event, mainFrame, dispatchMedia, requestMedia }
}

async function beginCapture(fixture: Awaited<ReturnType<typeof setup>>): Promise<void> {
  const snapshot = fixture.auth.getSnapshot()
  const result = await fixture.invoke('controlCharacterSearch', {
    action: 'begin',
    authRunId: snapshot.runId,
    authRevision: snapshot.revision
  })

  expect(result).toMatchObject({ ok: true, snapshot: { captureId: expect.any(String) } })
}

beforeEach(() => {
  vi.clearAllMocks()
  electron.getSources.mockResolvedValue(sources)
})
afterEach(() => vi.restoreAllMocks())

describe('capture main auth boundary', () => {
  it('검색 read는 capture를 시작하거나 인증 HTTP를 실행하지 않는다', async () => {
    const fixture = await setup()

    const result = await fixture.invoke('controlCharacterSearch', { action: 'read' })

    expect(result).toMatchObject({ ok: true, snapshot: { captureId: null } })
    expect(electron.getSources).not.toHaveBeenCalled()
    expect(fixture.harness.http.refresh).not.toHaveBeenCalled()
  })

  it('현재 auth와 선택 source로 begin하고 이전 end가 새 capture를 끝내지 않는다', async () => {
    const fixture = await setup()
    await fixture.invoke('selectCaptureSource', sources[0].id)
    const authSnapshot = fixture.auth.getSnapshot()
    const begin = {
      action: 'begin',
      authRunId: authSnapshot.runId,
      authRevision: authSnapshot.revision
    }

    const first = await fixture.invoke('controlCharacterSearch', begin)

    expect(first).toMatchObject({ ok: true, snapshot: { captureId: expect.any(String) } })
    const firstCaptureId = (first as { snapshot: { captureId: string } }).snapshot.captureId
    expect(firstCaptureId).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i)
    expect(await fixture.requestMedia()).toEqual({ video: sources[0] })
    expect(await fixture.invoke('controlCharacterSearch', begin)).toMatchObject({
      ok: false,
      error: { code: 'SEARCH_BUSY' }
    })

    const ended = await fixture.invoke('controlCharacterSearch', {
      action: 'end',
      captureId: firstCaptureId
    })

    expect(ended).toMatchObject({ ok: true, snapshot: { captureId: null } })
    expect(await fixture.requestMedia()).toBeNull()
    const second = await fixture.invoke('controlCharacterSearch', begin)
    expect(second).toMatchObject({ ok: true, snapshot: { captureId: expect.any(String) } })
    const secondCaptureId = (second as { snapshot: { captureId: string } }).snapshot.captureId
    expect(secondCaptureId).not.toBe(firstCaptureId)
    expect(
      await fixture.invoke('controlCharacterSearch', { action: 'end', captureId: firstCaptureId })
    ).toMatchObject({ ok: true, snapshot: { captureId: secondCaptureId } })
  })

  it.each(['missing-source', 'stale-auth', 'selecting-source'])(
    'begin은 %s 상태를 승인된 오류로 거절한다',
    async (condition) => {
      const fixture = await setup()
      const authSnapshot = fixture.auth.getSnapshot()
      const isStaleAuth = condition === 'stale-auth'
      const isSelectingSource = condition === 'selecting-source'
      const pending = deferred<typeof sources>()
      let selection: Promise<unknown> | undefined
      if (isStaleAuth) await fixture.invoke('selectCaptureSource', sources[0].id)
      if (isSelectingSource) {
        electron.getSources.mockReturnValueOnce(pending.promise)
        selection = fixture.invoke('selectCaptureSource', sources[0].id)
        await Promise.resolve()
      }
      const expectedCode = isStaleAuth
        ? 'STALE_SEARCH'
        : isSelectingSource
          ? 'SEARCH_BUSY'
          : 'SEARCH_NOT_ALLOWED'

      try {
        const result = await fixture.invoke('controlCharacterSearch', {
          action: 'begin',
          authRunId: authSnapshot.runId,
          authRevision: authSnapshot.revision + (isStaleAuth ? 1 : 0)
        })

        expect(result).toMatchObject({
          ok: false,
          error: { code: expectedCode },
          snapshot: { captureId: null }
        })
      } finally {
        pending.resolve(sources)
        await selection
      }
    }
  )

  it.each(['source-clear', 'logout'])(
    '%s는 main capture를 지우고 종료된 ID의 cleanup을 허용한다',
    async (condition) => {
      const fixture = await setup()
      await fixture.invoke('selectCaptureSource', sources[0].id)
      const authSnapshot = fixture.auth.getSnapshot()
      const begun = await fixture.invoke('controlCharacterSearch', {
        action: 'begin',
        authRunId: authSnapshot.runId,
        authRevision: authSnapshot.revision
      })
      expect(begun).toMatchObject({ ok: true, snapshot: { captureId: expect.any(String) } })
      const captureId = (begun as { snapshot: { captureId: string } }).snapshot.captureId
      const isLogout = condition === 'logout'

      if (isLogout) await fixture.auth.logout()
      else await fixture.invoke('selectCaptureSource', '')

      expect(await fixture.invoke('controlCharacterSearch', { action: 'read' })).toMatchObject({
        ok: true,
        snapshot: { captureId: null }
      })
      expect(
        await fixture.invoke('controlCharacterSearch', { action: 'end', captureId })
      ).toMatchObject({ ok: true, snapshot: { captureId: null } })
      expect(await fixture.requestMedia()).toBeNull()
    }
  )

  it('source 선택만으로는 begin 이전의 media 요청을 허용하지 않는다', async () => {
    const fixture = await setup()
    await fixture.invoke('selectCaptureSource', sources[0].id)

    expect(await fixture.requestMedia()).toBeNull()
  })

  it('이전 media 열거는 같은 source의 end와 새 begin 뒤에 stream을 허용하지 않는다', async () => {
    const fixture = await setup()
    await fixture.invoke('selectCaptureSource', sources[0].id)
    await beginCapture(fixture)
    const current = await fixture.invoke('controlCharacterSearch', { action: 'read' })
    expect(current).toMatchObject({ ok: true, snapshot: { captureId: expect.any(String) } })
    const captureId = (current as { snapshot: { captureId: string } }).snapshot.captureId
    const pending = deferred<typeof sources>()
    electron.getSources.mockReturnValueOnce(pending.promise)
    const callsBeforeMedia = electron.getSources.mock.calls.length
    const previousMedia = fixture.requestMedia()
    expect(electron.getSources).toHaveBeenCalledTimes(callsBeforeMedia + 1)

    await fixture.invoke('controlCharacterSearch', { action: 'end', captureId })
    await beginCapture(fixture)
    pending.resolve(sources)

    expect(await previousMedia).toBeNull()
    expect(await fixture.requestMedia()).toEqual({ video: sources[0] })
  })

  it.each([
    { name: '기존 shape', args: [{ slot: 0, nickname: '가나' }] },
    {
      name: '알 수 없는 field',
      args: [
        {
          captureId: '00000000-0000-4000-8000-000000000001',
          slot: 0,
          observationRevision: 1,
          nickname: '가나',
          unexpected: true
        }
      ]
    },
    {
      name: '추가 인자',
      args: [
        {
          captureId: '00000000-0000-4000-8000-000000000001',
          slot: 0,
          observationRevision: 1,
          nickname: '가나'
        },
        null
      ]
    }
  ])('관측의 $name는 정제된 입력 실패와 빈 현재 snapshot으로 응답한다', async ({ args }) => {
    const fixture = await setup()

    const result = await fixture.invoke('notifyStableNicknameDetected', ...args)

    expect(result).toEqual({
      ok: false,
      error: { code: 'INVALID_SEARCH_COMMAND' },
      snapshot: {
        runId: expect.any(String),
        revision: expect.any(Number),
        captureId: null,
        slots: [0, 1, 2, 3].map((slot) => ({
          slot,
          observationRevision: 0,
          requestId: null,
          nickname: null,
          state: 'idle',
          rows: [],
          error: null
        }))
      }
    })
    expect(fixture.harness.http.refresh).not.toHaveBeenCalled()
  })

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
    expect(await fixture.requestMedia()).toBeNull()
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
    await beginCapture(fixture)
    expect(await fixture.requestMedia(changes)).toBeNull()
  })

  it('선택 뒤 logout은 main source를 지우고 media를 거절한다', async () => {
    const fixture = await setup()
    await fixture.invoke('selectCaptureSource', sources[0].id)
    await beginCapture(fixture)
    await fixture.auth.logout()
    expect(await fixture.requestMedia()).toBeNull()
  })

  it.each(['logout', 'clear', 'document'])(
    'media 열거 중 %s이면 늦은 stream을 허용하지 않는다',
    async (kind) => {
      const fixture = await setup()
      await fixture.invoke('selectCaptureSource', sources[0].id)
      await beginCapture(fixture)
      const pending = deferred<typeof sources>()
      electron.getSources.mockReturnValue(pending.promise)
      const callsBeforeMedia = electron.getSources.mock.calls.length
      const media = fixture.requestMedia()
      expect(electron.getSources).toHaveBeenCalledTimes(callsBeforeMedia + 1)
      const isLogout = kind === 'logout'
      const isClear = kind === 'clear'
      if (isLogout) await fixture.auth.logout()
      else if (isClear) await fixture.invoke('selectCaptureSource', '')
      else fixture.mainFrame.url = 'about:blank'
      pending.resolve(sources)
      expect(await media).toBeNull()
    }
  )

  // Electron 39.8.10의 null 거절은 CAPTURE_FAILURE만 반환한다. {}는 별도 TypeError도 낸다.
  it('선택 없는 즉시 거절은 native null 결과를 한 번 전달한다', async () => {
    const fixture = await setup()
    const callback = vi.fn()

    fixture.dispatchMedia(callback)

    expect(callback).toHaveBeenCalledExactlyOnceWith(null)
  })

  it.each(['missing', 'failure'])(
    'media source %s는 native null로 거절하고 capture를 끝낸다',
    async (kind) => {
      const fixture = await setup()
      await fixture.invoke('selectCaptureSource', sources[0].id)
      await beginCapture(fixture)
      const isFailure = kind === 'failure'
      if (isFailure)
        electron.getSources.mockRejectedValue(new Error('Synthetic enumeration failure'))
      else electron.getSources.mockResolvedValue([])

      const callback = vi.fn()
      fixture.dispatchMedia(callback)
      await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(null))

      expect(await fixture.invoke('controlCharacterSearch', { action: 'read' })).toMatchObject({
        ok: true,
        snapshot: { captureId: null }
      })
      electron.getSources.mockResolvedValue(sources)
      await beginCapture(fixture)
      expect(await fixture.requestMedia()).toEqual({ video: sources[0] })
    }
  )

  it.each(['missing', 'failure'])(
    '이전 media의 늦은 %s 결과는 새 capture를 끝내거나 callback을 반복하지 않는다',
    async (kind) => {
      const fixture = await setup()
      await fixture.invoke('selectCaptureSource', sources[0].id)
      await beginCapture(fixture)
      const previous = await fixture.invoke('controlCharacterSearch', { action: 'read' })
      expect(previous).toMatchObject({ ok: true, snapshot: { captureId: expect.any(String) } })
      const captureId = (previous as { snapshot: { captureId: string } }).snapshot.captureId
      const pending = deferred<typeof sources>()
      electron.getSources.mockReturnValueOnce(pending.promise)
      const callsBeforeMedia = electron.getSources.mock.calls.length
      const callback = vi.fn()
      fixture.dispatchMedia(callback)
      expect(electron.getSources).toHaveBeenCalledTimes(callsBeforeMedia + 1)
      await fixture.invoke('controlCharacterSearch', { action: 'end', captureId })
      await beginCapture(fixture)
      const current = await fixture.invoke('controlCharacterSearch', { action: 'read' })

      const isFailure = kind === 'failure'
      if (isFailure) pending.reject(new Error('Synthetic enumeration failure'))
      else pending.resolve([])
      await vi.waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(null))

      expect(await fixture.invoke('controlCharacterSearch', { action: 'read' })).toEqual(current)
      expect(await fixture.requestMedia()).toEqual({ video: sources[0] })
    }
  )

  it.each(['allowed', 'denied'])(
    '비동기 %s callback이 소비 뒤 throw해도 다시 호출하지 않는다',
    async (kind) => {
      const fixture = await setup()
      await fixture.invoke('selectCaptureSource', sources[0].id)
      await beginCapture(fixture)
      const isDenied = kind === 'denied'
      if (isDenied) electron.getSources.mockResolvedValue([])
      const callback = vi.fn().mockImplementationOnce(() => {
        throw new Error('Synthetic callback already consumed')
      })
      const callsBeforeMedia = electron.getSources.mock.calls.length

      fixture.dispatchMedia(callback)
      expect(electron.getSources).toHaveBeenCalledTimes(callsBeforeMedia + 1)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(isDenied ? null : { video: sources[0] })
    }
  )

  it.each(['signedOut', 'logout'])(
    '%s에서 안정화 nickname 통지는 main 권한으로 거절한다',
    async (phase) => {
      const startsSignedIn = phase === 'logout'
      const fixture = await setup(startsSignedIn)
      vi.spyOn(console, 'info').mockImplementation(() => undefined)
      if (startsSignedIn) await fixture.auth.logout()
      await expect(
        fixture.invoke('notifyStableNicknameDetected', { slot: 0, nickname: 'SYNTHETIC_CANARY' })
      ).rejects.toThrow()
      expect(fixture.harness.http.refresh).not.toHaveBeenCalled()
    }
  )

  it('capture 조회·선택·media는 HTTP refresh 없이 실행하고 raw OCR를 log하지 않는다', async () => {
    const fixture = await setup()
    fixture.harness.clock.elapseWithoutTimers(16 * 60 * 1000)
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await fixture.invoke('listCaptureSources')
    await fixture.invoke('selectCaptureSource', sources[0].id)
    await beginCapture(fixture)
    expect(await fixture.requestMedia()).toEqual({ video: sources[0] })
    await fixture.invoke('notifyStableNicknameDetected', { slot: 0, nickname: 'SYNTHETIC_CANARY' })
    expect(fixture.harness.http.refresh).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})
