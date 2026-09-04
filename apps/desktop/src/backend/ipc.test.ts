import { ipcMain } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addHandler } from './ipc'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

describe('backend IPC adapter', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear()
  })

  it('contract channel과 handler를 Electron에 등록한다', () => {
    const handler = vi.fn()

    addHandler('message', handler)

    expect(ipcMain.handle).toHaveBeenCalledWith('message', handler)
  })
})
