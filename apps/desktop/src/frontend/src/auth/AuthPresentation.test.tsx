// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AuthPresentation } from './AuthPresentation'
import type { AuthPhase, AuthPresentationInput } from './presentation'

let container: HTMLDivElement
let root: Root
const onIntent = vi.fn()
const nickname = '<img src=x onerror=alert(1)>중립닉네임🙂'.repeat(4)

function snapshot(
  phase: AuthPhase,
  changes: Partial<AuthPresentationInput> = {}
): AuthPresentationInput {
  return {
    phase,
    providers: ['google', 'discord'],
    login: null,
    user: null,
    entry: null,
    notice: null,
    ...changes
  }
}

function pending(phase: AuthPhase, attemptId = 'fixture-attempt'): AuthPresentationInput {
  return snapshot(phase, {
    login: { attemptId, provider: 'google', expiresAt: '2030-01-01T00:10:00Z' }
  })
}

beforeEach(() => {
  onIntent.mockReset()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

type RenderInput = Readonly<{
  input: AuthPresentationInput
  commandPending?: boolean
}>

async function render({ input, commandPending = false }: RenderInput): Promise<void> {
  await act(async () =>
    root.render(
      <AuthPresentation snapshot={input} commandPending={commandPending} onIntent={onIntent} />
    )
  )
}

function labels(): string[] {
  return Array.from(container.querySelectorAll('button'), (button) => button.textContent ?? '')
}

async function click(label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => {
    const hasLabel = candidate.textContent === label
    return hasLabel
  })
  expect(button, `Expected button ${label}`).toBeDefined()
  await act(async () => button?.click())
}

it('shows only enabled providers and emits their exact intent without granting access', async () => {
  await render({ input: snapshot('signedOut', { providers: ['discord'] }) })

  expect(labels()).toEqual(['Discord로 계속하기'])
  expect(container.textContent).toContain('같은 이메일')
  await click('Discord로 계속하기')
  expect(onIntent).toHaveBeenCalledExactlyOnceWith({ type: 'beginLogin', provider: 'discord' })
  expect(container.textContent).not.toContain('화면 캡처')
})

it('shows a fixed unavailable notice when no provider is enabled', async () => {
  await render({ input: snapshot('signedOut', { providers: [] }) })

  expect(container.textContent).toContain('사용 가능한 로그인 방법이 없습니다')
  expect(labels()).toEqual([])
})

it.each(['startingLogin', 'waitingBrowser', 'exchanging'] as const)(
  '%s cancels only the currently rendered attempt and never offers a provider',
  async (phase) => {
    await render({ input: pending(phase) })
    expect(labels()).toContain('로그인 취소')
    expect(labels()).not.toContain('Google로 계속하기')
    await click('로그인 취소')
    expect(onIntent).toHaveBeenLastCalledWith({ type: 'cancelLogin', attemptId: 'fixture-attempt' })

    await render({ input: pending(phase, 'replacement-attempt') })
    await click('로그인 취소')
    expect(onIntent).toHaveBeenLastCalledWith({
      type: 'cancelLogin',
      attemptId: 'replacement-attempt'
    })
    expect(container.textContent).not.toContain('화면 캡처')
  }
)

it('describes waiting expiry and the limits of cancellation', async () => {
  await render({ input: pending('waitingBrowser') })

  expect(container.textContent).toContain('브라우저')
  expect(container.textContent).toContain('만료')
  expect(container.querySelector('time')?.dateTime).toBe('2030-01-01T00:10:00Z')
  expect(container.textContent).toContain('브라우저를 닫거나 서버 처리를 되돌리지는 않습니다')
})

it('invalid return 새 로그인 cancels then waits for signedOut instead of beginning login', async () => {
  const input = { ...pending('waitingBrowser'), notice: 'LOGIN_RETURN_INVALID' as const }
  await render({ input })
  await click('새 로그인')

  expect(onIntent).toHaveBeenCalledExactlyOnceWith({
    type: 'cancelLogin',
    attemptId: 'fixture-attempt'
  })
  expect(labels()).not.toContain('Google로 계속하기')
  await render({ input, commandPending: true })
  await click('새 로그인')
  expect(onIntent).toHaveBeenCalledTimes(1)

  await render({ input: snapshot('signedOut', { notice: 'LOGIN_CANCELLED' }) })
  await click('Google로 계속하기')
  expect(onIntent).toHaveBeenLastCalledWith({ type: 'beginLogin', provider: 'google' })
})

it.each(['restoring', 'signingOut'] as const)(
  '%s hides account and blocks activation',
  async (phase) => {
    await render({ input: snapshot(phase, { user: { nickname }, entry: 'home' }) })

    const isRestoring = phase === 'restoring'
    expect(container.textContent).toContain(isRestoring ? '복원 중' : '로그아웃 중')
    expect(container.textContent).not.toContain(nickname)
    expect(container.textContent).not.toContain('화면 캡처')
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.every((button) => button.disabled)).toBe(true)
    await act(async () => buttons.forEach((button) => button.click()))
    expect(onIntent).not.toHaveBeenCalled()
  }
)

it('restorePaused exposes only safe retry and device logout', async () => {
  await render({ input: snapshot('restorePaused', { notice: 'NETWORK_UNAVAILABLE' }) })

  expect(labels()).toEqual(['다시 시도', '이 기기 로그아웃'])
  expect(container.textContent).toContain('연결')
  await click('다시 시도')
  await click('이 기기 로그아웃')
  expect(onIntent.mock.calls).toEqual([[{ type: 'retryAuth' }], [{ type: 'logout' }]])
})

it('restorePaused presents the time-check notice with the same safe actions', async () => {
  await render({ input: snapshot('restorePaused', { notice: 'RESTORE_RETRY_REQUIRED' }) })

  expect(labels()).toEqual(['다시 시도', '이 기기 로그아웃'])
  expect(container.textContent).toContain('로그인 상태 확인을 마치지 못했습니다')
  await click('다시 시도')
  await click('이 기기 로그아웃')
  expect(onIntent.mock.calls).toEqual([[{ type: 'retryAuth' }], [{ type: 'logout' }]])
})

it.each(['SECURE_STORAGE_UNAVAILABLE', 'TOKEN_SAVE_FAILED', 'LOCAL_CLEAR_UNCONFIRMED'] as const)(
  'storageBlocked/%s permits retry only and hides injected protected data',
  async (notice) => {
    await render({
      input: snapshot('storageBlocked', { notice, user: { nickname }, entry: 'home' })
    })

    expect(labels()).toEqual(['다시 시도'])
    expect(container.textContent).not.toContain(nickname)
    expect(container.textContent).not.toContain('화면 캡처')
    await click('다시 시도')
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({ type: 'retryAuth' })
  }
)

it('discloses unconfirmed local deletion and server logout without claiming restart safety', async () => {
  await render({ input: snapshot('storageBlocked', { notice: 'LOCAL_CLEAR_UNCONFIRMED' }) })

  expect(container.textContent).toContain('서버 로그아웃도 확인하지 못했습니다')
  expect(container.textContent).toContain('재시작 후 안전한 차단을 보장할 수 없습니다')
})

it('preserves the explicit server-unconfirmed logout notice', async () => {
  await render({ input: snapshot('signedOut', { notice: 'LOGOUT_SERVER_UNCONFIRMED' }) })

  expect(container.textContent).toContain(
    '이 기기 정보는 지웠지만 서버 로그아웃은 확인하지 못했습니다'
  )
})

it('renders nickname as text; welcome dismissal lasts only for the mounted signed-in view', async () => {
  const welcome = snapshot('signedIn', { user: { nickname }, entry: 'welcome' })
  await render({ input: welcome })

  expect(container.textContent).toContain(nickname)
  expect(container.querySelector('img')).toBeNull()
  expect(container.textContent).not.toContain('화면 캡처')
  await click('시작하기')
  expect(container.textContent).toContain('화면 캡처')
  expect(onIntent).not.toHaveBeenCalled()
  await render({ input: { ...welcome } })
  expect(labels()).not.toContain('시작하기')

  await render({ input: snapshot('signingOut') })
  expect(container.textContent).not.toContain(nickname)
  await render({ input: welcome })
  expect(labels()).toContain('시작하기')
  await act(async () => root.unmount())
  root = createRoot(container)
  await render({ input: welcome })
  expect(labels()).toContain('시작하기')
})

it('existing home displays account and capture placeholder, and logout does not fabricate a snapshot', async () => {
  await render({ input: snapshot('signedIn', { user: { nickname }, entry: 'home' }) })

  expect(container.textContent).toContain(nickname)
  expect(container.textContent).toContain('화면 캡처')
  expect(labels()).toEqual(['이 기기 로그아웃'])
  await click('이 기기 로그아웃')
  expect(onIntent).toHaveBeenCalledExactlyOnceWith({ type: 'logout' })
  expect(container.textContent).toContain(nickname)
})

it.each([
  snapshot('signedOut'),
  pending('startingLogin'),
  pending('waitingBrowser'),
  pending('exchanging'),
  snapshot('restorePaused'),
  snapshot('storageBlocked'),
  snapshot('signedIn', { user: { nickname }, entry: 'home' })
])('commandPending disables every action in $phase', async (input) => {
  await render({ input, commandPending: true })

  const buttons = Array.from(container.querySelectorAll('button'))
  expect(buttons.length).toBeGreaterThan(0)
  expect(buttons.every((button) => button.disabled)).toBe(true)
  await act(async () => buttons.forEach((button) => button.click()))
  expect(onIntent).not.toHaveBeenCalled()
})

it('home content는 signedIn home에만 mount하고 인증 이탈 뒤 새로 mount한다', async () => {
  const mounted = vi.fn()
  const cleaned = vi.fn()
  function Home(): React.JSX.Element {
    useEffect(() => {
      mounted()
      return cleaned
    }, [])
    return <div>Capture content fixture</div>
  }
  const homeProps = { home: <Home /> }
  const renderHome = async (input: AuthPresentationInput): Promise<void> => {
    await act(async () =>
      root.render(<AuthPresentation snapshot={input} onIntent={onIntent} {...homeProps} />)
    )
  }
  await renderHome(snapshot('signedOut'))
  expect(mounted).not.toHaveBeenCalled()
  await renderHome(snapshot('signedIn', { user: { nickname: 'Synthetic' }, entry: 'welcome' }))
  expect(mounted).not.toHaveBeenCalled()
  await click('시작하기')
  expect(mounted).toHaveBeenCalledOnce()
  await renderHome(snapshot('signingOut'))
  expect(cleaned).toHaveBeenCalledOnce()
  expect(container.textContent).not.toContain('Capture content fixture')
  await renderHome(snapshot('signedIn', { user: { nickname: 'Synthetic' }, entry: 'home' }))
  expect(mounted).toHaveBeenCalledTimes(2)
})
