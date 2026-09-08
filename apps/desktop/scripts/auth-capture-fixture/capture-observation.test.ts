import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { AuthCoordinator } from '../../src/backend/auth/types'
import { registerObservedCapture } from './capture-observation'

const product = vi.hoisted(() => ({ result: null as Electron.Streams | null }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../../src/backend/capture/ipc-handler', () => ({
  registerCaptureIpc: () => vi.fn(),
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
