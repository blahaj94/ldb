import { ipcMain, type BrowserWindow } from 'electron'
import type { AuthCoordinator } from '../../src/backend/auth/types'
import { registerCaptureIpc, registerCaptureWindow } from '../../src/backend/capture/ipc-handler'

export type CaptureObservation = {
  displayRequests: number
  displayAllowed: number
  nicknameInvokes: number
  nicknameAccepted: number
}

export function registerObservedCapture(
  coordinator: AuthCoordinator,
  window: BrowserWindow,
  documentUrl: string
): { counts: CaptureObservation; dispose: () => void } {
  const counts = { displayRequests: 0, displayAllowed: 0, nicknameInvokes: 0, nicknameAccepted: 0 }
  const session = window.webContents.session
  const originalDisplay = session.setDisplayMediaRequestHandler
  const originalHandle = ipcMain.handle
  // 실제 제품 handler를 그대로 호출하며 고정 counter만 관측한다.
  session.setDisplayMediaRequestHandler = (handler, options) => {
    const hasHandler = handler != null
    if (!hasHandler) {
      originalDisplay.call(session, handler, options)
      return
    }
    originalDisplay.call(
      session,
      (request, callback) => {
        counts.displayRequests += 1
        handler(request, (streams) => {
          const isAllowed = streams.video != null
          if (isAllowed) counts.displayAllowed += 1
          callback(streams)
        })
      },
      options
    )
  }
  ipcMain.handle = (channel, listener) => {
    const isNickname = channel === 'notifyStableNicknameDetected'
    if (!isNickname) {
      originalHandle.call(ipcMain, channel, listener)
      return
    }
    originalHandle.call(ipcMain, channel, (event, ...args) => {
      counts.nicknameInvokes += 1
      const result = listener(event, ...args)
      counts.nicknameAccepted += 1
      return result
    })
  }
  try {
    const dispose = registerCaptureIpc(coordinator)
    registerCaptureWindow(window, documentUrl)
    return { counts, dispose }
  } finally {
    session.setDisplayMediaRequestHandler = originalDisplay
    ipcMain.handle = originalHandle
  }
}
