// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AuthSnapshot } from '../../preload/common/types/auth'
import App from './App'

let root: Root
let container: HTMLDivElement
let listener: ((snapshot: AuthSnapshot) => void) | undefined
const capture = {
  listCaptureSources: vi.fn(),
  selectCaptureSource: vi.fn(),
  notifyStableNicknameDetected: vi.fn()
}
const auth = {
  getAuthState: vi.fn(),
  onAuthStateChanged: vi.fn(),
  beginLogin: vi.fn(),
  cancelLogin: vi.fn(),
  retryAuth: vi.fn(),
  logout: vi.fn()
}
function snapshot(revision: number, phase: 'signedIn' | 'signedOut'): AuthSnapshot {
  const isSignedIn = phase === 'signedIn'
  return {
    runId: 'fixture-run',
    revision,
    phase,
    providers: [],
    login: null,
    user: isSignedIn ? { nickname: 'Synthetic' } : null,
    entry: isSignedIn ? 'home' : null,
    notice: null
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'api', { configurable: true, value: capture })
  Object.defineProperty(window, 'auth', { configurable: true, value: auth })
  capture.listCaptureSources.mockResolvedValue([{ id: 'fixture', name: 'Synthetic window' }])
  capture.selectCaptureSource.mockResolvedValue({ id: 'fixture', name: 'Synthetic window' })
  auth.onAuthStateChanged.mockImplementation((next) => {
    listener = next
    return vi.fn()
  })
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
})
it('auth 연결이 없는 기본 entry는 capture를 mount하지 않고 고정 실패 안내를 표시한다', async () => {
  auth.getAuthState.mockRejectedValue(new Error('No handler registered'))
  await act(async () => root.render(<App />))
  expect(capture.listCaptureSources).not.toHaveBeenCalled()
  expect(container.textContent).toContain('인증 연결을 확인할 수 없습니다')
})
it('실제 capture는 home에서 선택을 요구하고 인증 이탈·재진입 때 선택을 초기화한다', async () => {
  auth.getAuthState.mockResolvedValue(snapshot(1, 'signedIn'))
  await act(async () => root.render(<App />))
  const selection = container.querySelector('select')
  expect(selection).not.toBeNull()
  await act(async () => {
    if (selection != null) {
      selection.value = 'fixture'
      selection.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
  expect(capture.selectCaptureSource).toHaveBeenCalledWith('fixture')
  await act(async () => listener?.(snapshot(2, 'signedOut')))
  expect(container.querySelector('select')).toBeNull()
  expect(capture.selectCaptureSource).toHaveBeenLastCalledWith('')
  await act(async () => listener?.(snapshot(3, 'signedIn')))
  expect(container.querySelector('select')?.value).toBe('')
  const start = Array.from(container.querySelectorAll('button')).find((button) => {
    const isStart = button.textContent === 'Start'
    return isStart
  })
  expect(start?.disabled).toBe(true)
})

it('인증 이탈과 새 signedIn이 한 render로 합쳐져도 이전 capture 선택을 정리한다', async () => {
  auth.getAuthState.mockResolvedValue(snapshot(1, 'signedIn'))
  await act(async () => root.render(<App />))
  const selection = container.querySelector('select')
  await act(async () => {
    if (selection != null) {
      selection.value = 'fixture'
      selection.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
  expect(container.querySelector('select')?.value).toBe('fixture')

  await act(async () => listener?.(snapshot(2, 'signedIn')))
  expect(container.querySelector('select')?.value).toBe('fixture')
  expect(capture.listCaptureSources).toHaveBeenCalledOnce()

  await act(async () => {
    listener?.(snapshot(3, 'signedOut'))
    listener?.(snapshot(4, 'signedIn'))
  })

  expect(container.querySelector('select')?.value).toBe('')
  expect(capture.selectCaptureSource).toHaveBeenLastCalledWith('')
  expect(capture.listCaptureSources).toHaveBeenCalledTimes(2)
})
