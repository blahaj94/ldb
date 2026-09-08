import { ipcMain, type BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { AuthCoordinator } from '../../src/backend/auth/types'
import { registerObservedCapture } from './capture-observation'

const product = vi.hoisted(() => ({
  result: null as Electron.Streams | null,
  rejectNickname: false
}))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../../src/backend/capture/ipc-handler', () => ({
  registerCaptureIpc: () => {
    ipcMain.handle('notifyStableNicknameDetected', () => {
      if (product.rejectNickname) throw new Error('Synthetic handler rejection')
    })
    return vi.fn()
  },
  registerCaptureWindow: (window: BrowserWindow) => {
    window.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
      // Pinned native runtime은 null 거절을 받지만 공개 Streams type에는 빠져 있다.
      const nativeCallback = callback as (streams: Electron.Streams | null) => void
      nativeCallback(product.result)
    })
  }
}))

describe('fixture actual handler observation', () => {
  it.each([null, { video: { id: 'synthetic-window' } }])(
    'native 결과 %j를 바꾸지 않고 callback에 한 번 전달한다',
    (result) => {
      product.result = result as Electron.Streams | null
      const setDisplayMediaRequestHandler = vi.fn()
      const session = { setDisplayMediaRequestHandler }
      const window = { webContents: { session } } as unknown as BrowserWindow
      const observation = registerObservedCapture({} as AuthCoordinator, window, 'file:///fixture')
      const handler = setDisplayMediaRequestHandler.mock.calls[0][0]
      const callback = vi.fn()

      expect(() => handler({}, callback)).not.toThrow()

      expect(callback).toHaveBeenCalledExactlyOnceWith(result)
      expect(observation.counts.displayRequests).toBe(1)
      const isDenied = result == null
      expect(observation.counts.displayAllowed).toBe(isDenied ? 0 : 1)
    }
  )
})

describe('main synthetic nickname observation', () => {
  it.each([
    { name: '네 slot 모두 일치', slots: [0, 1, 2, 3], incorrect: -1, mask: 0b1111 },
    { name: 'slot 4 누락', slots: [0, 1, 2], incorrect: -1, mask: 0b0111 },
    { name: 'slot 4 오인식', slots: [0, 1, 2, 3], incorrect: 3, mask: 0b0111 },
    { name: '같은 slot 중복', slots: [0, 0, 0, 0], incorrect: -1, mask: 0b0001 }
  ])('$name은 제품 handler 통과 뒤 slot별 일치만 기록한다', ({ slots, incorrect, mask }) => {
    product.rejectNickname = false
    vi.mocked(ipcMain.handle).mockClear()
    const window = {
      webContents: { session: { setDisplayMediaRequestHandler: vi.fn() } }
    } as unknown as BrowserWindow
    const { counts } = registerObservedCapture({} as AuthCoordinator, window, 'file:///fixture')
    const listener = vi.mocked(ipcMain.handle).mock.calls[0][1]
    for (const slot of slots) {
      const isIncorrect = slot === incorrect
      listener({} as Electron.IpcMainInvokeEvent, {
        slot,
        nickname: isIncorrect ? 'WRONG' : 'ALICE'
      })
    }

    expect(counts).toHaveProperty('nicknameMatchedSlots', mask)
    expect(JSON.stringify(counts)).not.toContain('ALICE')
    expect(JSON.stringify(counts)).not.toContain('WRONG')
  })

  it('제품 handler가 거절한 정확한 합성 통지는 일치로 기록하지 않는다', () => {
    product.rejectNickname = true
    vi.mocked(ipcMain.handle).mockClear()
    const window = {
      webContents: { session: { setDisplayMediaRequestHandler: vi.fn() } }
    } as unknown as BrowserWindow
    const { counts } = registerObservedCapture({} as AuthCoordinator, window, 'file:///fixture')
    const listener = vi.mocked(ipcMain.handle).mock.calls[0][1]

    expect(() =>
      listener({} as Electron.IpcMainInvokeEvent, { slot: 0, nickname: 'ALICE' })
    ).toThrow()

    expect(counts).toHaveProperty('nicknameMatchedSlots', 0)
    product.rejectNickname = false
  })
})
