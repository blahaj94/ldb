import type { BrowserWindow } from 'electron'
import type { AuthCoordinator } from '../../src/backend/auth/types'

export function registerFixtureMediaPermissions(
  window: BrowserWindow,
  documentUrl: string,
  coordinator: Pick<AuthCoordinator, 'captureGeneration'>
): void {
  const session = window.webContents.session
  session.setPermissionCheckHandler(() => false)
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const isRegistered = contents === window.webContents
    const isWindowAlive = !window.isDestroyed()
    const isContentsAlive = isWindowAlive && !window.webContents.isDestroyed()
    const isUnavailableContents = !isRegistered || !isContentsAlive
    if (isUnavailableContents) {
      callback(false)
      return
    }
    const frame = window.webContents.mainFrame
    const hasFrame = frame != null
    const isFrameAttached = hasFrame && !frame.detached
    const isFrameAlive = isFrameAttached && !frame.isDestroyed()
    const isMainFrame = details.isMainFrame === true
    const hasCurrentDocument = isFrameAlive && frame.url === documentUrl
    const hasRequestDocument = details.requestingUrl === documentUrl
    const isSignedIn = coordinator.captureGeneration() != null
    const isMedia = permission === 'media'
    const hasMediaTypes = 'mediaTypes' in details
    const mediaTypes = hasMediaTypes ? details.mediaTypes : undefined
    const isMediaTypesArray = Array.isArray(mediaTypes)
    const hasEmptyMediaTypes = isMediaTypesArray && mediaTypes.length === 0
    const canAllow =
      isMainFrame &&
      hasCurrentDocument &&
      hasRequestDocument &&
      isSignedIn &&
      isMedia &&
      hasEmptyMediaTypes
    callback(canAllow)
  })
}
