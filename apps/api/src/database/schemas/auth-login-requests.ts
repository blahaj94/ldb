import { EntitySchema } from 'typeorm'
import type { AuthProvider } from '../../types/auth.js'
import type { Buffer } from 'node:buffer'
import { authLoginRequestColumns } from './auth-login-request.columns.js'
import {
  authLoginRequestValueChecks,
  authLoginRequestFieldGroupChecks,
  authLoginRequestStateChecks,
} from './auth-login-request.checks.js'

export interface AuthLoginRequest {
  id: string
  purpose: 'login'
  provider: AuthProvider
  clientId: 'desktop'
  providerConfigVersion: string
  returnTargetId: string
  createdAt: Date
  expiresAt: Date
  status: 'created' | 'browser_started' | 'processing' | 'exchange_ready' | 'consumed' | 'failed'
  codeChallenge: string | null
  method: 'S256' | null
  launchTicketHash: Buffer | null
  stateHash: Buffer | null
  browserBindingHash: Buffer | null
  oidcNonceHash: Buffer | null
  providerPkceCiphertext: Buffer | null
  providerPkceIv: Buffer | null
  providerPkceTag: Buffer | null
  providerPkceKeyId: string | null
  verifiedSubject: string | null
  exchangeCodeHash: Buffer | null
  codeExpiresAt: Date | null
  consumedAt: Date | null
}

export const AuthLoginRequestSchema = new EntitySchema<AuthLoginRequest>({
  name: 'AuthLoginRequest',
  tableName: 'auth_login_requests',
  columns: authLoginRequestColumns,
  uniques: [
    { name: 'uq_auth_login_requests_launch_ticket_hash', columns: ['launchTicketHash'] },
    { name: 'uq_auth_login_requests_state_hash', columns: ['stateHash'] },
    { name: 'uq_auth_login_requests_exchange_code_hash', columns: ['exchangeCodeHash'] },
  ],
  indices: [
    { name: 'idx_auth_login_requests_expires_at', columns: ['expiresAt'] },
  ],
  checks: [
    ...authLoginRequestValueChecks,
    ...authLoginRequestFieldGroupChecks,
    ...authLoginRequestStateChecks,
  ],
})
