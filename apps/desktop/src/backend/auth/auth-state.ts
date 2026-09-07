import type { RecoveryPurpose, StorageRecoveryPurpose } from './recovery-plan'
import type {
  AuthCommandError,
  AuthCommandResult,
  AuthNotice,
  AuthPhase,
  AuthProvider,
  AuthSnapshot
} from './types'

type SnapshotState = Readonly<{
  phase: AuthPhase
  login: AuthSnapshot['login']
  user: AuthSnapshot['user']
  entry: AuthSnapshot['entry']
  notice: AuthNotice | null
}>

type LoginPhase = 'startingLogin' | 'waitingBrowser' | 'exchanging'
type InactivePhase = Exclude<AuthPhase, LoginPhase | 'signedIn'>
type StorageNotice = 'SECURE_STORAGE_UNAVAILABLE' | 'LOCAL_CLEAR_UNCONFIRMED' | 'TOKEN_SAVE_FAILED'

export class AuthState {
  private revision = 0
  private recovery: RecoveryPurpose | null = null
  private current: SnapshotState = {
    phase: 'restoring',
    login: null,
    user: null,
    entry: null,
    notice: null
  }
  private readonly listeners = new Set<(snapshot: AuthSnapshot) => void>()

  constructor(
    private readonly runId: string,
    private readonly providers: readonly AuthProvider[]
  ) {}

  get recoveryPurpose(): RecoveryPurpose | null {
    return this.recovery
  }

  get phase(): AuthPhase {
    return this.current.phase
  }

  readonly getSnapshot = (): AuthSnapshot => {
    const login = this.current.login
    const user = this.current.user
    const hasLogin = login != null
    const hasUser = user != null
    return {
      runId: this.runId,
      revision: this.revision,
      phase: this.current.phase,
      providers: [...this.providers],
      login: hasLogin
        ? { attemptId: login.attemptId, provider: login.provider, expiresAt: login.expiresAt }
        : null,
      user: hasUser ? { nickname: user.nickname } : null,
      entry: this.current.entry,
      notice: this.current.notice
    }
  }

  readonly subscribe = (listener: (snapshot: AuthSnapshot) => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  success(current = this.getSnapshot()): AuthCommandResult {
    return { ok: true, snapshot: current }
  }

  failure(code: AuthCommandError): AuthCommandResult {
    return { ok: false, error: { code }, snapshot: this.getSnapshot() }
  }

  loginStarted(login: NonNullable<AuthSnapshot['login']>): AuthSnapshot {
    return this.publishLogin('startingLogin', login, null)
  }

  waitingForBrowser(
    login: NonNullable<AuthSnapshot['login']>,
    notice: 'LOGIN_RETURN_INVALID' | null = null
  ): AuthSnapshot {
    return this.publishLogin('waitingBrowser', login, notice)
  }

  exchangeStarted(login: NonNullable<AuthSnapshot['login']>): AuthSnapshot {
    return this.publishLogin('exchanging', login, null)
  }

  signedIn(nickname: string, entry: 'welcome' | 'home'): AuthSnapshot {
    this.recovery = null
    return this.publish({
      phase: 'signedIn',
      login: null,
      user: { nickname },
      entry,
      notice: null
    })
  }

  signedOut(notice: AuthNotice | null = null): AuthSnapshot {
    this.recovery = null
    return this.publishInactive('signedOut', notice)
  }

  restoring(): AuthSnapshot {
    return this.publishInactive('restoring', null)
  }

  restorePaused(notice: 'NETWORK_UNAVAILABLE' | 'AUTH_SERVICE_UNAVAILABLE'): AuthSnapshot {
    this.recovery = 'resume-credential'
    return this.publishInactive('restorePaused', notice)
  }

  signingOut(): AuthSnapshot {
    this.recovery = null
    return this.publishInactive('signingOut', null)
  }

  storageBlocked(notice: StorageNotice, purpose: StorageRecoveryPurpose): AuthSnapshot {
    this.recovery = purpose
    return this.publishInactive('storageBlocked', notice)
  }

  private publishLogin(
    phase: LoginPhase,
    login: NonNullable<AuthSnapshot['login']>,
    notice: AuthNotice | null
  ): AuthSnapshot {
    this.recovery = null
    return this.publish({ phase, login, user: null, entry: null, notice })
  }

  private publishInactive(phase: InactivePhase, notice: AuthNotice | null): AuthSnapshot {
    return this.publish({ phase, login: null, user: null, entry: null, notice })
  }

  private publish(next: SnapshotState): AuthSnapshot {
    const canIncrement = this.revision < Number.MAX_SAFE_INTEGER
    if (!canIncrement) {
      throw new Error('Auth snapshot revision is exhausted.')
    }
    this.revision += 1
    this.current = next
    const published = this.getSnapshot()
    for (const listener of this.listeners) {
      try {
        listener(published)
      } catch {
        // Snapshot consumer 실패가 main의 credential state 전이를 되돌리지 않게 한다.
      }
    }
    return published
  }
}
