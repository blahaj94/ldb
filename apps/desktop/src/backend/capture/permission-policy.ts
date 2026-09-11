import type { Session } from 'electron'

export function registerCapturePermissions(
  session: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>
): void {
  session.setPermissionCheckHandler(() => false)
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
}
