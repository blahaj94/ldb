import { ipcRenderer } from 'electron'
import type { SearchApi } from '../common/types/search'
import { parseSearchSnapshot } from '../common/search/snapshot'
import { invokeSearchCommand } from './search-command'

export const controlCharacterSearch: SearchApi['controlCharacterSearch'] = (control) =>
  invokeSearchCommand('controlCharacterSearch', control)

export const onCharacterSearchChanged: SearchApi['onCharacterSearchChanged'] = (listener) => {
  const wrapper = (_event: Electron.IpcRendererEvent, value: unknown): void => {
    const snapshot = parseSearchSnapshot(value)
    const isValid = snapshot != null
    if (isValid) {
      listener(snapshot)
    }
  }
  ipcRenderer.on('characterSearchChanged', wrapper)
  return () => {
    ipcRenderer.removeListener('characterSearchChanged', wrapper)
  }
}
