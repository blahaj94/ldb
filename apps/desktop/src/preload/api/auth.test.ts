import { beforeEach, expect, it, vi } from 'vitest'
import * as auth from './auth'

const renderer = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: renderer }))
beforeEach(() => vi.clearAllMocks())

it('feature API는 5 invoke와 단일 event subscription만 노출한다', async () => {
  expect(Object.keys(auth).sort()).toEqual([
    'beginLogin',
    'cancelLogin',
    'getAuthState',
    'logout',
    'onAuthStateChanged',
    'retryAuth'
  ])
  const attemptId = '00000000-0000-4000-8000-000000000002'
  await auth.getAuthState()
  await auth.beginLogin({ provider: 'google' })
  await auth.cancelLogin({ attemptId })
  await auth.retryAuth()
  await auth.logout()

  expect(renderer.invoke.mock.calls).toEqual([
    ['getAuthState'],
    ['beginLogin', { provider: 'google' }],
    ['cancelLogin', { attemptId }],
    ['retryAuth'],
    ['logout']
  ])
})

it('raw Electron event를 제거하고 각 listener의 wrapper만 해제한다', () => {
  const first = vi.fn()
  const second = vi.fn()
  const unsubscribe = auth.onAuthStateChanged(first)
  auth.onAuthStateChanged(second)
  const [[channel, firstWrapper], [, secondWrapper]] = renderer.on.mock.calls
  const snapshot = { runId: 'synthetic-run', revision: 1 }
  const rawEvent = { sender: 'must-not-cross-bridge' }

  firstWrapper(rawEvent, snapshot)
  secondWrapper(rawEvent, snapshot)
  unsubscribe()

  expect(channel).toBe('authStateChanged')
  expect(first).toHaveBeenCalledExactlyOnceWith(snapshot)
  expect(second).toHaveBeenCalledExactlyOnceWith(snapshot)
  expect(renderer.removeListener).toHaveBeenCalledExactlyOnceWith('authStateChanged', firstWrapper)
  expect(firstWrapper).not.toBe(secondWrapper)
})
