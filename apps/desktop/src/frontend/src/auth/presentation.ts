import type { ReactNode } from 'react'

// Renderer-local input. 실제 DTO adapter·구독·revision 처리는 후속 연결에서 맡는다.
export type AuthProvider = 'google' | 'discord'
export type AuthPhase =
  | 'signedOut'
  | 'startingLogin'
  | 'waitingBrowser'
  | 'exchanging'
  | 'restoring'
  | 'restorePaused'
  | 'signedIn'
  | 'signingOut'
  | 'storageBlocked'

export type AuthNotice =
  | 'LOGIN_CANCELLED'
  | 'LOGIN_EXPIRED'
  | 'LOGIN_RETURN_INVALID'
  | 'LOGIN_RESTART_REQUIRED'
  | 'BROWSER_OPEN_FAILED'
  | 'NETWORK_UNAVAILABLE'
  | 'AUTH_SERVICE_UNAVAILABLE'
  | 'REAUTH_REQUIRED'
  | 'SECURE_STORAGE_UNAVAILABLE'
  | 'TOKEN_SAVE_FAILED'
  | 'LOCAL_CLEAR_UNCONFIRMED'
  | 'LOGOUT_SERVER_UNCONFIRMED'

export interface AuthPresentationInput {
  phase: AuthPhase
  providers: readonly AuthProvider[]
  login: { attemptId: string; provider: AuthProvider; expiresAt: string | null } | null
  user: { nickname: string } | null
  entry: 'welcome' | 'home' | null
  notice: AuthNotice | null
}

export type AuthIntent =
  | { type: 'beginLogin'; provider: AuthProvider }
  | { type: 'cancelLogin'; attemptId: string }
  | { type: 'retryAuth' }
  | { type: 'logout' }

export interface AuthPresentationProps {
  snapshot: AuthPresentationInput
  home?: ReactNode
  commandPending?: boolean
  onIntent: (intent: AuthIntent) => void
}
