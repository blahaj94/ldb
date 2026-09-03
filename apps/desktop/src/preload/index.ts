import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  listCaptureSources: (): Promise<{ id: string; name: string }[]> =>
    electronAPI.ipcRenderer.invoke('capture:list-sources'),
  selectCaptureSource: (sourceId: string): Promise<{ id: string; name: string }> =>
    electronAPI.ipcRenderer.invoke('capture:select-source', sourceId),
  reportStableNickname: (slot: number, nickname: string): void =>
    electronAPI.ipcRenderer.send('capture:stable-nickname', { slot, nickname })
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
