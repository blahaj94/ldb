import { AUTH_PROVIDERS } from '../../constants/auth.js'
import type { EntitySchemaOptions } from 'typeorm'
import type { AuthLoginRequest } from './auth-login-requests.js'

type LoginChecks = NonNullable<EntitySchemaOptions<AuthLoginRequest>['checks']>

// 동일한 SQL fragment만 공유한다. NULL guard와 공백을 포함한 최종 expression은 변경하지 않는다.
const activeClientProof = `"code_challenge" IS NOT NULL AND "method" IS NOT NULL AND "method" = 'S256'`
const browserClaimFields = `${activeClientProof}
      AND "launch_ticket_hash" IS NULL
      AND "state_hash" IS NOT NULL AND "browser_binding_hash" IS NOT NULL
      AND ("provider" <> '${AUTH_PROVIDERS.GOOGLE}' OR "oidc_nonce_hash" IS NOT NULL)
      AND "provider_pkce_ciphertext" IS NOT NULL AND "provider_pkce_iv" IS NOT NULL
      AND "provider_pkce_tag" IS NOT NULL AND "provider_pkce_key_id" IS NOT NULL
      AND "verified_subject" IS NULL AND "exchange_code_hash" IS NULL
      AND "code_expires_at" IS NULL AND "consumed_at" IS NULL`
const terminalClearedFields = `"code_challenge" IS NULL AND "method" IS NULL AND "launch_ticket_hash" IS NULL
      AND "state_hash" IS NULL AND "browser_binding_hash" IS NULL AND "oidc_nonce_hash" IS NULL
      AND "provider_pkce_ciphertext" IS NULL AND "provider_pkce_iv" IS NULL
      AND "provider_pkce_tag" IS NULL AND "provider_pkce_key_id" IS NULL
      AND "verified_subject" IS NULL AND "exchange_code_hash" IS NULL
      AND "code_expires_at" IS NULL`

export const authLoginRequestValueChecks = [
  { name: 'ck_auth_login_requests_purpose', expression: `"purpose" = 'login'` },
  {
    name: 'ck_auth_login_requests_provider',
    expression: `"provider" IN ('${AUTH_PROVIDERS.GOOGLE}', '${AUTH_PROVIDERS.DISCORD}')`
  },
  { name: 'ck_auth_login_requests_client', expression: `"client_id" = 'desktop'` },
  {
    name: 'ck_auth_login_requests_config_nonempty',
    expression: `char_length("provider_config_version") > 0`
  },
  {
    name: 'ck_auth_login_requests_return_target_nonempty',
    expression: `char_length("return_target_id") > 0`
  },
  {
    name: 'ck_auth_login_requests_status',
    expression: `"status" IN ('created', 'browser_started', 'processing', 'exchange_ready', 'consumed', 'failed')`
  },
  { name: 'ck_auth_login_requests_method', expression: `"method" IS NULL OR "method" = 'S256'` },
  {
    name: 'ck_auth_login_requests_code_challenge_nonempty',
    expression: `"code_challenge" IS NULL OR char_length("code_challenge") > 0`
  },
  {
    name: 'ck_auth_login_requests_launch_hash_length',
    expression: `"launch_ticket_hash" IS NULL OR octet_length("launch_ticket_hash") = 32`
  },
  {
    name: 'ck_auth_login_requests_state_hash_length',
    expression: `"state_hash" IS NULL OR octet_length("state_hash") = 32`
  },
  {
    name: 'ck_auth_login_requests_browser_hash_length',
    expression: `"browser_binding_hash" IS NULL OR octet_length("browser_binding_hash") = 32`
  },
  {
    name: 'ck_auth_login_requests_nonce_hash_length',
    expression: `"oidc_nonce_hash" IS NULL OR octet_length("oidc_nonce_hash") = 32`
  },
  {
    name: 'ck_auth_login_requests_exchange_hash_length',
    expression: `"exchange_code_hash" IS NULL OR octet_length("exchange_code_hash") = 32`
  },
  {
    name: 'ck_auth_login_requests_subject_nonempty',
    expression: `"verified_subject" IS NULL OR char_length("verified_subject") > 0`
  }
] satisfies LoginChecks

export const authLoginRequestFieldGroupChecks = [
  { name: 'ck_auth_login_requests_expiry', expression: `"expires_at" > "created_at"` },
  {
    name: 'ck_auth_login_requests_pkce_fields',
    expression: `
      ("provider_pkce_ciphertext" IS NULL AND "provider_pkce_iv" IS NULL AND "provider_pkce_tag" IS NULL AND "provider_pkce_key_id" IS NULL)
      OR
      ("provider_pkce_ciphertext" IS NOT NULL AND "provider_pkce_iv" IS NOT NULL
      AND "provider_pkce_tag" IS NOT NULL AND "provider_pkce_key_id" IS NOT NULL
      AND octet_length("provider_pkce_ciphertext") > 0 AND octet_length("provider_pkce_iv") = 12
      AND octet_length("provider_pkce_tag") = 16 AND char_length("provider_pkce_key_id") > 0)
      `
  },
  {
    name: 'ck_auth_login_requests_code_deadline',
    expression: `"code_expires_at" IS NULL OR "code_expires_at" <= "expires_at"`
  }
] satisfies LoginChecks

export const authLoginRequestStateChecks = [
  {
    name: 'ck_auth_login_requests_created_fields',
    expression: `
      "status" <> 'created' OR (
      ${activeClientProof}
      AND "launch_ticket_hash" IS NOT NULL
      AND "state_hash" IS NULL AND "browser_binding_hash" IS NULL AND "oidc_nonce_hash" IS NULL
      AND "provider_pkce_ciphertext" IS NULL AND "provider_pkce_iv" IS NULL
      AND "provider_pkce_tag" IS NULL AND "provider_pkce_key_id" IS NULL
      AND "verified_subject" IS NULL AND "exchange_code_hash" IS NULL
      AND "code_expires_at" IS NULL AND "consumed_at" IS NULL
      )
      `
  },
  {
    name: 'ck_auth_login_requests_browser_started_fields',
    expression: `
      "status" <> 'browser_started' OR (
      ${browserClaimFields}
      )
      `
  },
  {
    name: 'ck_auth_login_requests_processing_fields',
    expression: `
      "status" <> 'processing' OR (
      ${browserClaimFields}
      )
      `
  },
  {
    name: 'ck_auth_login_requests_exchange_ready_fields',
    expression: `
      "status" <> 'exchange_ready' OR (
      ${activeClientProof}
      AND "launch_ticket_hash" IS NULL
      AND "verified_subject" IS NOT NULL AND "exchange_code_hash" IS NOT NULL
      AND "code_expires_at" IS NOT NULL AND "consumed_at" IS NULL
      )
      `
  },
  {
    name: 'ck_auth_login_requests_consumed_fields',
    expression: `
      "status" <> 'consumed' OR (
      ${terminalClearedFields} AND "consumed_at" IS NOT NULL
      )
      `
  },
  {
    name: 'ck_auth_login_requests_failed_fields',
    expression: `
      "status" <> 'failed' OR (
      ${terminalClearedFields} AND "consumed_at" IS NULL
      )
      `
  }
] satisfies LoginChecks
