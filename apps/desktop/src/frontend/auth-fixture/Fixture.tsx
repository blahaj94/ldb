import { useState } from 'react'
import { AuthPresentation } from '../src/auth/AuthPresentation'
import type { AuthIntent, AuthPresentationInput } from '../src/auth/presentation'

const empty: AuthPresentationInput = {
  phase: 'signedOut',
  providers: ['google', 'discord'],
  login: null,
  user: null,
  entry: null,
  notice: null
}
const login = {
  attemptId: 'synthetic-attempt',
  provider: 'google' as const,
  expiresAt: '2030-01-01T00:10:00Z'
}
const user = { nickname: '중립닉네임🙂' }
const cases: Record<string, AuthPresentationInput> = {
  signedOut: empty,
  startingLogin: { ...empty, phase: 'startingLogin', login: { ...login, expiresAt: null } },
  waitingBrowser: { ...empty, phase: 'waitingBrowser', login },
  invalidReturn: { ...empty, phase: 'waitingBrowser', login, notice: 'LOGIN_RETURN_INVALID' },
  exchanging: { ...empty, phase: 'exchanging', login },
  restoring: { ...empty, phase: 'restoring' },
  restorePaused: { ...empty, phase: 'restorePaused', notice: 'NETWORK_UNAVAILABLE' },
  welcome: { ...empty, phase: 'signedIn', user, entry: 'welcome' },
  home: { ...empty, phase: 'signedIn', user, entry: 'home' },
  longNickname: {
    ...empty,
    phase: 'signedIn',
    user: { nickname: 'W'.repeat(20) },
    entry: 'welcome'
  },
  signingOut: { ...empty, phase: 'signingOut' },
  storageBlocked: { ...empty, phase: 'storageBlocked', notice: 'LOCAL_CLEAR_UNCONFIRMED' },
  noProviders: { ...empty, providers: [] }
}

export function Fixture(): React.JSX.Element {
  const requested = new URLSearchParams(location.search).get('state') ?? 'signedOut'
  const [snapshot, setSnapshot] = useState(cases[requested] ?? empty)
  const [commandPending, setCommandPending] = useState(false)

  function onIntent(intent: AuthIntent): void {
    setCommandPending(true)
    // Synthetic gesture의 결과만 보여준다. 제품 API·auth·capture를 import하지 않는다.
    setTimeout(() => {
      switch (intent.type) {
        case 'beginLogin':
          setSnapshot({ ...cases.waitingBrowser, login: { ...login, provider: intent.provider } })
          break
        case 'cancelLogin':
          setSnapshot({ ...empty, notice: 'LOGIN_CANCELLED' })
          break
        case 'retryAuth':
          setSnapshot(cases.restoring)
          break
        case 'logout':
          setSnapshot(cases.signingOut)
          break
      }
      setCommandPending(false)
    }, 800)
  }

  return (
    <AuthPresentation snapshot={snapshot} commandPending={commandPending} onIntent={onIntent} />
  )
}
