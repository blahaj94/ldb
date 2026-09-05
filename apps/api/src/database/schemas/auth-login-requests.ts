import { EntitySchema } from 'typeorm'
import type { Buffer } from 'node:buffer'

export interface AuthLoginRequest {
  id: string
  purpose: 'login'
  provider: 'google' | 'discord'
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
  columns: {
    id: { type: 'uuid', primary: true, primaryKeyConstraintName: 'pk_auth_login_requests' },
    purpose: { type: 'text' },
    provider: { type: 'text' },
    clientId: { name: 'client_id', type: 'text' },
    providerConfigVersion: { name: 'provider_config_version', type: 'text' },
    returnTargetId: { name: 'return_target_id', type: 'text' },
    createdAt: { name: 'created_at', type: 'timestamptz', precision: 0 },
    expiresAt: { name: 'expires_at', type: 'timestamptz', precision: 0 },
    status: { type: 'text' },
    codeChallenge: { name: 'code_challenge', type: 'text', nullable: true },
    method: { type: 'text', nullable: true },
    launchTicketHash: { name: 'launch_ticket_hash', type: 'bytea', nullable: true },
    stateHash: { name: 'state_hash', type: 'bytea', nullable: true },
    browserBindingHash: { name: 'browser_binding_hash', type: 'bytea', nullable: true },
    oidcNonceHash: { name: 'oidc_nonce_hash', type: 'bytea', nullable: true },
    providerPkceCiphertext: { name: 'provider_pkce_ciphertext', type: 'bytea', nullable: true },
    providerPkceIv: { name: 'provider_pkce_iv', type: 'bytea', nullable: true },
    providerPkceTag: { name: 'provider_pkce_tag', type: 'bytea', nullable: true },
    providerPkceKeyId: { name: 'provider_pkce_key_id', type: 'text', nullable: true },
    verifiedSubject: { name: 'verified_subject', type: 'text', nullable: true },
    exchangeCodeHash: { name: 'exchange_code_hash', type: 'bytea', nullable: true },
    codeExpiresAt: { name: 'code_expires_at', type: 'timestamptz', precision: 0, nullable: true },
    consumedAt: { name: 'consumed_at', type: 'timestamptz', precision: 0, nullable: true },
  },
  uniques: [
    { name: 'uq_auth_login_requests_launch_ticket_hash', columns: ['launchTicketHash'] },
    { name: 'uq_auth_login_requests_state_hash', columns: ['stateHash'] },
    { name: 'uq_auth_login_requests_exchange_code_hash', columns: ['exchangeCodeHash'] },
  ],
  indices: [
    { name: 'idx_auth_login_requests_expires_at', columns: ['expiresAt'] },
  ],
  checks: [
    { name: 'ck_auth_login_requests_purpose', expression: `"purpose" = 'login'` },
    { name: 'ck_auth_login_requests_provider', expression: `"provider" IN ('google', 'discord')` },
    { name: 'ck_auth_login_requests_client', expression: `"client_id" = 'desktop'` },
    { name: 'ck_auth_login_requests_config_nonempty', expression: `char_length("provider_config_version") > 0` },
    { name: 'ck_auth_login_requests_return_target_nonempty', expression: `char_length("return_target_id") > 0` },
    { name: 'ck_auth_login_requests_expiry', expression: `"expires_at" > "created_at"` },
    { name: 'ck_auth_login_requests_status', expression: `"status" IN ('created', 'browser_started', 'processing', 'exchange_ready', 'consumed', 'failed')` },
    { name: 'ck_auth_login_requests_method', expression: `"method" IS NULL OR "method" = 'S256'` },
    { name: 'ck_auth_login_requests_code_challenge_nonempty', expression: `"code_challenge" IS NULL OR char_length("code_challenge") > 0` },
    { name: 'ck_auth_login_requests_launch_hash_length', expression: `"launch_ticket_hash" IS NULL OR octet_length("launch_ticket_hash") = 32` },
    { name: 'ck_auth_login_requests_state_hash_length', expression: `"state_hash" IS NULL OR octet_length("state_hash") = 32` },
    { name: 'ck_auth_login_requests_browser_hash_length', expression: `"browser_binding_hash" IS NULL OR octet_length("browser_binding_hash") = 32` },
    { name: 'ck_auth_login_requests_nonce_hash_length', expression: `"oidc_nonce_hash" IS NULL OR octet_length("oidc_nonce_hash") = 32` },
    { name: 'ck_auth_login_requests_exchange_hash_length', expression: `"exchange_code_hash" IS NULL OR octet_length("exchange_code_hash") = 32` },
    {
      name: 'ck_auth_login_requests_pkce_fields',
      expression: `
      ("provider_pkce_ciphertext" IS NULL AND "provider_pkce_iv" IS NULL AND "provider_pkce_tag" IS NULL AND "provider_pkce_key_id" IS NULL)
      OR
      ("provider_pkce_ciphertext" IS NOT NULL AND "provider_pkce_iv" IS NOT NULL
      AND "provider_pkce_tag" IS NOT NULL AND "provider_pkce_key_id" IS NOT NULL
      AND octet_length("provider_pkce_ciphertext") > 0 AND octet_length("provider_pkce_iv") = 12
      AND octet_length("provider_pkce_tag") = 16 AND char_length("provider_pkce_key_id") > 0)
      `,
    },
    { name: 'ck_auth_login_requests_subject_nonempty', expression: `"verified_subject" IS NULL OR char_length("verified_subject") > 0` },
    { name: 'ck_auth_login_requests_code_deadline', expression: `"code_expires_at" IS NULL OR "code_expires_at" <= "expires_at"` },
    {
      name: 'ck_auth_login_requests_created_fields',
      expression: `
      "status" <> 'created' OR (
      "code_challenge" IS NOT NULL AND "method" IS NOT NULL AND "method" = 'S256'
      AND "launch_ticket_hash" IS NOT NULL
      AND "state_hash" IS NULL AND "browser_binding_hash" IS NULL AND "oidc_nonce_hash" IS NULL
      AND "provider_pkce_ciphertext" IS NULL AND "provider_pkce_iv" IS NULL
      AND "provider_pkce_tag" IS NULL AND "provider_pkce_key_id" IS NULL
      AND "verified_subject" IS NULL AND "exchange_code_hash" IS NULL
      AND "code_expires_at" IS NULL AND "consumed_at" IS NULL
      )
      `,
    },
    {
      name: 'ck_auth_login_requests_browser_started_fields',
      expression: `
      "status" <> 'browser_started' OR (
      "code_challenge" IS NOT NULL AND "method" IS NOT NULL AND "method" = 'S256'
      AND "launch_ticket_hash" IS NULL
      AND "state_hash" IS NOT NULL AND "browser_binding_hash" IS NOT NULL
      AND ("provider" <> 'google' OR "oidc_nonce_hash" IS NOT NULL)
      AND "provider_pkce_ciphertext" IS NOT NULL AND "provider_pkce_iv" IS NOT NULL
      AND "provider_pkce_tag" IS NOT NULL AND "provider_pkce_key_id" IS NOT NULL
      AND "verified_subject" IS NULL AND "exchange_code_hash" IS NULL
      AND "code_expires_at" IS NULL AND "consumed_at" IS NULL
      )
      `,
    },
    {
      name: 'ck_auth_login_requests_processing_fields',
      expression: `
      "status" <> 'processing' OR (
      "code_challenge" IS NOT NULL AND "method" IS NOT NULL AND "method" = 'S256'
      AND "launch_ticket_hash" IS NULL
      AND "state_hash" IS NOT NULL AND "browser_binding_hash" IS NOT NULL
      AND ("provider" <> 'google' OR "oidc_nonce_hash" IS NOT NULL)
      AND "provider_pkce_ciphertext" IS NOT NULL AND "provider_pkce_iv" IS NOT NULL
      AND "provider_pkce_tag" IS NOT NULL AND "provider_pkce_key_id" IS NOT NULL
      AND "verified_subject" IS NULL AND "exchange_code_hash" IS NULL
      AND "code_expires_at" IS NULL AND "consumed_at" IS NULL
      )
      `,
    },
    {
      name: 'ck_auth_login_requests_exchange_ready_fields',
      expression: `
      "status" <> 'exchange_ready' OR (
      "code_challenge" IS NOT NULL AND "method" IS NOT NULL AND "method" = 'S256'
      AND "launch_ticket_hash" IS NULL
      AND "verified_subject" IS NOT NULL AND "exchange_code_hash" IS NOT NULL
      AND "code_expires_at" IS NOT NULL AND "consumed_at" IS NULL
      )
      `,
    },
    {
      name: 'ck_auth_login_requests_consumed_fields',
      expression: `
      "status" <> 'consumed' OR (
      "code_challenge" IS NULL AND "method" IS NULL AND "launch_ticket_hash" IS NULL
      AND "state_hash" IS NULL AND "browser_binding_hash" IS NULL AND "oidc_nonce_hash" IS NULL
      AND "provider_pkce_ciphertext" IS NULL AND "provider_pkce_iv" IS NULL
      AND "provider_pkce_tag" IS NULL AND "provider_pkce_key_id" IS NULL
      AND "verified_subject" IS NULL AND "exchange_code_hash" IS NULL
      AND "code_expires_at" IS NULL AND "consumed_at" IS NOT NULL
      )
      `,
    },
    {
      name: 'ck_auth_login_requests_failed_fields',
      expression: `
      "status" <> 'failed' OR (
      "code_challenge" IS NULL AND "method" IS NULL AND "launch_ticket_hash" IS NULL
      AND "state_hash" IS NULL AND "browser_binding_hash" IS NULL AND "oidc_nonce_hash" IS NULL
      AND "provider_pkce_ciphertext" IS NULL AND "provider_pkce_iv" IS NULL
      AND "provider_pkce_tag" IS NULL AND "provider_pkce_key_id" IS NULL
      AND "verified_subject" IS NULL AND "exchange_code_hash" IS NULL
      AND "code_expires_at" IS NULL AND "consumed_at" IS NULL
      )
      `,
    },
  ],
})
