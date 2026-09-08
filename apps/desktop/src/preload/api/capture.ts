import { makeHandlerInvoker } from '../ipc'
import type { AsyncIPCFunctions } from '../common/types/ipc'
import { invokeSearchCommand } from './search-command'

export const listCaptureSources = makeHandlerInvoker('listCaptureSources')
export const selectCaptureSource = makeHandlerInvoker('selectCaptureSource')
export const notifyStableNicknameDetected: AsyncIPCFunctions['notifyStableNicknameDetected'] = (
  observation
) => invokeSearchCommand('notifyStableNicknameDetected', observation)
