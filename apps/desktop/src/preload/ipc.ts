import { ipcRenderer } from 'electron'
import type { AsyncIPCFunctions } from './common/types/ipc'

type PromiseOnce<T> = T extends Promise<unknown> ? T : Promise<T>

function makeHandlerInvoker<ChannelName extends keyof AsyncIPCFunctions>(channel: ChannelName) {
  return (...args: Parameters<AsyncIPCFunctions[ChannelName]>) =>
    ipcRenderer.invoke(channel, ...args) as PromiseOnce<ReturnType<AsyncIPCFunctions[ChannelName]>>
}

export { makeHandlerInvoker }
