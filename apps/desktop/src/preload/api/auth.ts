import { ipcRenderer } from 'electron'
import { makeHandlerInvoker } from '../ipc'
import type { AuthApi, AuthSnapshot } from '../common/types/auth'

export const getAuthState = makeHandlerInvoker('getAuthState')
export const beginLogin = makeHandlerInvoker('beginLogin')
export const cancelLogin = makeHandlerInvoker('cancelLogin')
export const retryAuth = makeHandlerInvoker('retryAuth')
export const logout = makeHandlerInvoker('logout')
export const onAuthStateChanged: AuthApi['onAuthStateChanged'] = (listener) => {
  const wrapper = (_event: Electron.IpcRendererEvent, snapshot: AuthSnapshot): void => {
    listener(snapshot)
  }
  ipcRenderer.on('authStateChanged', wrapper)
  return () => ipcRenderer.removeListener('authStateChanged', wrapper)
}
