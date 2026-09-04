import { makeHandlerInvoker } from '../ipc'

export const listCaptureSources = makeHandlerInvoker('listCaptureSources')
export const selectCaptureSource = makeHandlerInvoker('selectCaptureSource')
export const notifyStableNicknameDetected = makeHandlerInvoker('notifyStableNicknameDetected')
