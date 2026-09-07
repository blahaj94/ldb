import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { addHandler } from '../ipc'
import type { AsyncIPCFunctions } from '../../preload/common/types/ipc'
import type { AuthCoordinator, AuthSnapshot, AuthCommandResult } from './types'

type Mutation = 'beginLogin' | 'cancelLogin' | 'retryAuth' | 'logout'
type Options = {
  coordinator: AuthCoordinator
  getWindow: () => BrowserWindow | null
  documentUrl: string
}

function publicSnapshot(snapshot: AuthSnapshot): AuthSnapshot {
  const { runId, revision, phase, providers, login, user, entry, notice } = snapshot
  const hasLogin = login != null
  const hasUser = user != null
  return {
    runId,
    revision,
    phase,
    providers: [...providers],
    entry,
    notice,
    login: hasLogin
      ? { attemptId: login.attemptId, provider: login.provider, expiresAt: login.expiresAt }
      : null,
    user: hasUser ? { nickname: user.nickname } : null
  }
}

function exactField(args: unknown[], key: string): unknown {
  const hasOneArgument = args.length === 1
  const value = args[0]
  const isObject = value != null && typeof value === 'object' && !Array.isArray(value)
  if (!hasOneArgument || !isObject) return undefined
  const keys = Reflect.ownKeys(value)
  const hasExactKey = keys.length === 1 && keys[0] === key
  if (!hasExactKey) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function validArguments(channel: Mutation, args: unknown[]): boolean {
  const isBegin = channel === 'beginLogin'
  if (isBegin) {
    const provider = exactField(args, 'provider')
    const isGoogle = provider === 'google'
    const isDiscord = provider === 'discord'
    const isProvider = isGoogle || isDiscord
    return isProvider
  }
  const isCancel = channel === 'cancelLogin'
  if (isCancel) {
    const attemptId = exactField(args, 'attemptId')
    const isString = typeof attemptId === 'string'
    const isUuid =
      isString && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(attemptId)
    return isUuid
  }
  const hasNoArguments = args.length === 0
  return hasNoArguments
}

export function registerAuthIpc({ coordinator, getWindow, documentUrl }: Options): () => void {
  let disposed = false

  function allowedWindow(window: BrowserWindow | null): window is BrowserWindow {
    const hasWindow = window != null
    if (!hasWindow || disposed) return false
    const isWindowDestroyed = window.isDestroyed()
    if (isWindowDestroyed) return false
    const contents = window.webContents
    const isContentsDestroyed = contents.isDestroyed()
    if (isContentsDestroyed) return false
    const frame = contents.mainFrame
    const hasFrame = frame != null
    const isCurrentDocument = hasFrame && !frame.detached && frame.url === documentUrl
    return isCurrentDocument
  }

  function requireSender(event: IpcMainInvokeEvent, expected = getWindow()): BrowserWindow {
    const isCurrentWindow = expected === getWindow()
    const isWindowAllowed = isCurrentWindow && allowedWindow(expected)
    if (!isWindowAllowed) throw new Error('AUTH_NOT_ALLOWED')
    const isSender = event.sender === expected.webContents
    const isMainFrame = event.senderFrame === expected.webContents.mainFrame
    const isAllowed = isSender && isMainFrame
    if (!isAllowed) throw new Error('AUTH_NOT_ALLOWED')
    return expected
  }

  const getAuthState = async (
    event: IpcMainInvokeEvent,
    ...args: Parameters<AsyncIPCFunctions['getAuthState']>
  ): Promise<AuthSnapshot> => {
    requireSender(event)
    const hasNoArguments = args.length === 0
    if (!hasNoArguments) throw new Error('INVALID_AUTH_COMMAND')
    return publicSnapshot(coordinator.getSnapshot())
  }
  addHandler('getAuthState', getAuthState)

  async function mutate(
    channel: Mutation,
    event: IpcMainInvokeEvent,
    args: unknown[]
  ): Promise<AuthCommandResult> {
    const window = requireSender(event)
    const hasValidArguments = validArguments(channel, args)
    if (!hasValidArguments)
      return {
        ok: false,
        error: { code: 'INVALID_AUTH_COMMAND' },
        snapshot: publicSnapshot(coordinator.getSnapshot())
      }
    let result: AuthCommandResult
    try {
      switch (channel) {
        case 'beginLogin':
          result = await coordinator.beginLogin(exactField(args, 'provider'))
          break
        case 'cancelLogin':
          result = await coordinator.cancelLogin(exactField(args, 'attemptId'))
          break
        case 'retryAuth':
          result = await coordinator.retryAuth()
          break
        case 'logout':
          result = await coordinator.logout()
          break
      }
    } catch {
      requireSender(event, window)
      return {
        ok: false,
        error: { code: 'AUTH_OPERATION_FAILED' },
        snapshot: publicSnapshot(coordinator.getSnapshot())
      }
    }
    requireSender(event, window)
    const snapshot = publicSnapshot(result.snapshot)
    if (result.ok) return { ok: true, snapshot }
    return { ok: false, error: { code: result.error.code }, snapshot }
  }
  addHandler('beginLogin', (event, ...args) => mutate('beginLogin', event, args))
  addHandler('cancelLogin', (event, ...args) => mutate('cancelLogin', event, args))
  addHandler('retryAuth', (event, ...args) => mutate('retryAuth', event, args))
  addHandler('logout', (event, ...args) => mutate('logout', event, args))

  const unsubscribe = coordinator.subscribe((snapshot) => {
    const window = getWindow()
    const isAllowed = allowedWindow(window)
    if (!isAllowed) return
    window.webContents.send('authStateChanged', publicSnapshot(snapshot))
  })
  return () => {
    disposed = true
    unsubscribe()
    for (const channel of ['getAuthState', 'beginLogin', 'cancelLogin', 'retryAuth', 'logout']) {
      ipcMain.removeHandler(channel)
    }
  }
}
