import type { BrowserWindow, Session } from 'electron'
import type { AuthCoordinator } from '../auth/types'

type CapturePermissionAuth = Pick<AuthCoordinator, 'captureGeneration'>

export function registerCapturePermissions(
  session: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>,
  window: BrowserWindow,
  documentUrl: string,
  auth?: CapturePermissionAuth
): void {
  session.setPermissionCheckHandler(() => false)
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const isRegisteredContents = contents === window.webContents
    const isWindowAlive = !window.isDestroyed()
    const isContentsAlive = !window.webContents.isDestroyed()
    const hasAvailableContents = isRegisteredContents && isWindowAlive && isContentsAlive
    if (!hasAvailableContents) {
      callback(false)
      return
    }

    const frame = window.webContents.mainFrame
    const hasFrame = frame != null
    const isFrameAttached = hasFrame ? !frame.detached : false
    const isFrameAlive = hasFrame ? !frame.isDestroyed() : false
    const hasCurrentDocument =
      isFrameAttached && isFrameAlive && hasFrame ? frame.url === documentUrl : false
    const isMainFrame = details.isMainFrame === true
    const hasRequestDocument = details.requestingUrl === documentUrl
    const isSignedIn = auth?.captureGeneration() != null
    const isMedia = permission === 'media'
    const hasMediaTypes = 'mediaTypes' in details
    const mediaTypes = hasMediaTypes ? details.mediaTypes : undefined
    const isMediaTypesArray = Array.isArray(mediaTypes)
    const hasEmptyMediaTypes = isMediaTypesArray && mediaTypes.length === 0
    const canAllow =
      isMainFrame &&
      isFrameAttached &&
      isFrameAlive &&
      hasCurrentDocument &&
      hasRequestDocument &&
      isSignedIn &&
      isMedia &&
      hasEmptyMediaTypes

    callback(canAllow)
  })
}
