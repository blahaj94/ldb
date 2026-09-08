import type { EntitySchemaColumnOptions, EntitySchemaOptions } from 'typeorm'
import type { AuthLoginRequest } from './auth-login-requests.js'

type LoginColumns = EntitySchemaOptions<AuthLoginRequest>['columns']

const text = { type: 'text' } satisfies EntitySchemaColumnOptions
const nullableText = { ...text, nullable: true } satisfies EntitySchemaColumnOptions
const nullableBinary = { type: 'bytea', nullable: true } satisfies EntitySchemaColumnOptions
const timestamp = { type: 'timestamptz', precision: 0 } satisfies EntitySchemaColumnOptions
const nullableTimestamp = { ...timestamp, nullable: true } satisfies EntitySchemaColumnOptions

const identityColumns = {
  id: { type: 'uuid', primary: true, primaryKeyConstraintName: 'pk_auth_login_requests' },
  purpose: { ...text },
  provider: { ...text },
  clientId: { name: 'client_id', ...text },
  providerConfigVersion: { name: 'provider_config_version', ...text },
  returnTargetId: { name: 'return_target_id', ...text }
} satisfies Partial<LoginColumns>

const lifecycleColumns = {
  createdAt: { name: 'created_at', ...timestamp },
  expiresAt: { name: 'expires_at', ...timestamp },
  status: { ...text }
} satisfies Partial<LoginColumns>

const clientPkceColumns = {
  codeChallenge: { name: 'code_challenge', ...nullableText },
  method: { ...nullableText }
} satisfies Partial<LoginColumns>

const browserContextColumns = {
  launchTicketHash: { name: 'launch_ticket_hash', ...nullableBinary },
  stateHash: { name: 'state_hash', ...nullableBinary },
  browserBindingHash: { name: 'browser_binding_hash', ...nullableBinary },
  oidcNonceHash: { name: 'oidc_nonce_hash', ...nullableBinary }
} satisfies Partial<LoginColumns>

const providerPkceColumns = {
  providerPkceCiphertext: { name: 'provider_pkce_ciphertext', ...nullableBinary },
  providerPkceIv: { name: 'provider_pkce_iv', ...nullableBinary },
  providerPkceTag: { name: 'provider_pkce_tag', ...nullableBinary },
  providerPkceKeyId: { name: 'provider_pkce_key_id', ...nullableText }
} satisfies Partial<LoginColumns>

// 교환 결과와 소비 시간. 기존 property와 생성 column 순서도 유지한다.
const exchangeCodeColumns = {
  verifiedSubject: { name: 'verified_subject', ...nullableText },
  exchangeCodeHash: { name: 'exchange_code_hash', ...nullableBinary },
  codeExpiresAt: { name: 'code_expires_at', ...nullableTimestamp },
  consumedAt: { name: 'consumed_at', ...nullableTimestamp }
} satisfies Partial<LoginColumns>

export const authLoginRequestColumns = {
  ...identityColumns,
  ...lifecycleColumns,
  ...clientPkceColumns,
  ...browserContextColumns,
  ...providerPkceColumns,
  ...exchangeCodeColumns
} satisfies LoginColumns
