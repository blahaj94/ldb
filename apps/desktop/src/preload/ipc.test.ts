import { ipcRenderer } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeHandlerInvoker } from './ipc'

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: vi.fn()
  }
}))

describe('preload IPC adapter', () => {
  beforeEach(() => {
    vi.mocked(ipcRenderer.invoke).mockReset()
  })

  it('contract channel과 argument를 Electron에 전달한다', async () => {
    vi.mocked(ipcRenderer.invoke).mockResolvedValue('response')

    const invoke = makeHandlerInvoker('message')

    await expect(invoke('request')).resolves.toBe('response')
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('message', 'request')
  })
})
