export type {
  AuthSnapshot,
  AuthCommandResult,
  AuthProvider,
  AuthPhase,
  AuthNotice
} from '../../../backend/auth/types'
import type { AsyncIPCFunctions } from './ipc'
import type { AuthSnapshot } from '../../../backend/auth/types'

export type AuthApi = Pick<
  AsyncIPCFunctions,
  'getAuthState' | 'beginLogin' | 'cancelLogin' | 'retryAuth' | 'logout'
> & {
  onAuthStateChanged: (listener: (snapshot: AuthSnapshot) => void) => () => void
}
