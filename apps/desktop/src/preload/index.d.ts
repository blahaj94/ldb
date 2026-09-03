import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      listCaptureSources: () => Promise<{ id: string; name: string }[]>
      selectCaptureSource: (sourceId: string) => Promise<{ id: string; name: string }>
      reportStableNickname: (slot: number, nickname: string) => void
    }
  }
}
