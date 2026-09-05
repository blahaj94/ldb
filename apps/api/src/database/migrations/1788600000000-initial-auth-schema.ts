import type { MigrationInterface, QueryRunner } from 'typeorm'

export class InitialAuthSchema1788600000000 implements MigrationInterface {
  readonly name = 'InitialAuthSchema1788600000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL,
        "provider" text NOT NULL,
        "provider_subject" text COLLATE "C" NOT NULL,
        "nickname" text NOT NULL,
        "created_at" timestamptz(0) NOT NULL,
        CONSTRAINT "pk_users" PRIMARY KEY ("id"),
        CONSTRAINT "uq_users_provider_subject" UNIQUE ("provider", "provider_subject"),
        CONSTRAINT "ck_users_provider" CHECK ("provider" IN ('google', 'discord')),
        CONSTRAINT "ck_users_provider_subject_nonempty" CHECK (char_length("provider_subject") > 0),
        CONSTRAINT "ck_users_nickname_nonempty" CHECK (char_length("nickname") > 0)
      );

      CREATE TABLE "auth_sessions" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "created_at" timestamptz(0) NOT NULL,
        "last_active_at" timestamptz(0) NOT NULL,
        "revoked_at" timestamptz(0),
        "revoked_reason" text,
        CONSTRAINT "pk_auth_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "fk_auth_sessions_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "ck_auth_sessions_last_active" CHECK ("last_active_at" >= "created_at"),
        CONSTRAINT "ck_auth_sessions_revoked_pair" CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL)),
        CONSTRAINT "ck_auth_sessions_revoked_time" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at"),
        CONSTRAINT "ck_auth_sessions_revoked_reason" CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN ('logout', 'refresh_reuse'))
      );
      CREATE INDEX "idx_auth_sessions_user_id" ON "auth_sessions" ("user_id");
      CREATE INDEX "idx_auth_sessions_last_active_at" ON "auth_sessions" ("last_active_at");

      CREATE TABLE "auth_refresh_tokens" (
        "token_hash" bytea NOT NULL,
        "session_id" uuid NOT NULL,
        "issued_at" timestamptz(0) NOT NULL,
        "consumed_at" timestamptz(0),
        CONSTRAINT "pk_auth_refresh_tokens" PRIMARY KEY ("token_hash"),
        CONSTRAINT "fk_auth_refresh_tokens_session" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id") ON DELETE CASCADE,
        CONSTRAINT "ck_auth_refresh_tokens_hash_length" CHECK (octet_length("token_hash") = 32),
        CONSTRAINT "ck_auth_refresh_tokens_consumed_time" CHECK ("consumed_at" IS NULL OR "consumed_at" >= "issued_at")
      );
      CREATE UNIQUE INDEX "uq_auth_refresh_tokens_unconsumed_session" ON "auth_refresh_tokens" ("session_id") WHERE "consumed_at" IS NULL;
      CREATE INDEX "idx_auth_refresh_tokens_session_id" ON "auth_refresh_tokens" ("session_id");

      CREATE TABLE "auth_login_requests" (
        "id" uuid NOT NULL,
        "purpose" text NOT NULL,
        "provider" text NOT NULL,
        "client_id" text NOT NULL,
        "provider_config_version" text NOT NULL,
        "return_target_id" text NOT NULL,
        "created_at" timestamptz(0) NOT NULL,
        "expires_at" timestamptz(0) NOT NULL,
        "status" text NOT NULL,
        "code_challenge" text,
        "method" text,
        "launch_ticket_hash" bytea,
        "state_hash" bytea,
        "browser_binding_hash" bytea,
        "oidc_nonce_hash" bytea,
        "provider_pkce_ciphertext" bytea,
        "provider_pkce_iv" bytea,
        "provider_pkce_tag" bytea,
        "provider_pkce_key_id" text,
        "verified_subject" text,
        "exchange_code_hash" bytea,
        "code_expires_at" timestamptz(0),
        "consumed_at" timestamptz(0),
        CONSTRAINT "pk_auth_login_requests" PRIMARY KEY ("id"),
        CONSTRAINT "uq_auth_login_requests_launch_ticket_hash" UNIQUE ("launch_ticket_hash"),
        CONSTRAINT "uq_auth_login_requests_state_hash" UNIQUE ("state_hash"),
        CONSTRAINT "uq_auth_login_requests_exchange_code_hash" UNIQUE ("exchange_code_hash"),
        CONSTRAINT "ck_auth_login_requests_purpose" CHECK ("purpose" = 'login'),
        CONSTRAINT "ck_auth_login_requests_provider" CHECK ("provider" IN ('google', 'discord')),
        CONSTRAINT "ck_auth_login_requests_client" CHECK ("client_id" = 'desktop'),
        CONSTRAINT "ck_auth_login_requests_config_nonempty" CHECK (char_length("provider_config_version") > 0),
        CONSTRAINT "ck_auth_login_requests_return_target_nonempty" CHECK (char_length("return_target_id") > 0),
        CONSTRAINT "ck_auth_login_requests_expiry" CHECK ("expires_at" > "created_at"),
        CONSTRAINT "ck_auth_login_requests_status" CHECK ("status" IN ('created', 'browser_started', 'processing', 'exchange_ready', 'consumed', 'failed')),
        CONSTRAINT "ck_auth_login_requests_method" CHECK ("method" IS NULL OR "method" = 'S256'),
        CONSTRAINT "ck_auth_login_requests_code_challenge_nonempty" CHECK ("code_challenge" IS NULL OR char_length("code_challenge") > 0),
        CONSTRAINT "ck_auth_login_requests_launch_hash_length" CHECK ("launch_ticket_hash" IS NULL OR octet_length("launch_ticket_hash") = 32),
        CONSTRAINT "ck_auth_login_requests_state_hash_length" CHECK ("state_hash" IS NULL OR octet_length("state_hash") = 32),
        CONSTRAINT "ck_auth_login_requests_browser_hash_length" CHECK ("browser_binding_hash" IS NULL OR octet_length("browser_binding_hash") = 32),
        CONSTRAINT "ck_auth_login_requests_nonce_hash_length" CHECK ("oidc_nonce_hash" IS NULL OR octet_length("oidc_nonce_hash") = 32),
        CONSTRAINT "ck_auth_login_requests_exchange_hash_length" CHECK ("exchange_code_hash" IS NULL OR octet_length("exchange_code_hash") = 32),
        CONSTRAINT "ck_auth_login_requests_pkce_fields" CHECK (
          ("provider_pkce_ciphertext" IS NULL AND "provider_pkce_iv" IS NULL AND "provider_pkce_tag" IS NULL AND "provider_pkce_key_id" IS NULL)
          OR
          ("provider_pkce_ciphertext" IS NOT NULL AND "provider_pkce_iv" IS NOT NULL
            AND "provider_pkce_tag" IS NOT NULL AND "provider_pkce_key_id" IS NOT NULL
            AND octet_length("provider_pkce_ciphertext") > 0 AND octet_length("provider_pkce_iv") = 12
            AND octet_length("provider_pkce_tag") = 16 AND char_length("provider_pkce_key_id") > 0)
        ),
        CONSTRAINT "ck_auth_login_requests_subject_nonempty" CHECK ("verified_subject" IS NULL OR char_length("verified_subject") > 0),
        CONSTRAINT "ck_auth_login_requests_code_deadline" CHECK ("code_expires_at" IS NULL OR "code_expires_at" <= "expires_at"),
        CONSTRAINT "ck_auth_login_requests_created_fields" CHECK (
          "status" <> 'created' OR (
            "code_challenge" IS NOT NULL AND "method" IS NOT NULL AND "method" = 'S256'
            AND "launch_ticket_hash" IS NOT NULL
            AND "state_hash" IS NULL AND "browser_binding_hash" IS NULL AND "oidc_nonce_hash" IS NULL
            AND "provider_pkce_ciphertext" IS NULL AND "provider_pkce_iv" IS NULL
            AND "provider_pkce_tag" IS NULL AND "provider_pkce_key_id" IS NULL
            AND "verified_subject" IS NULL AND "exchange_code_hash" IS NULL
            AND "code_expires_at" IS NULL AND "consumed_at" IS NULL
          )
        ),
        CONSTRAINT "ck_auth_login_requests_browser_started_fields" CHECK (
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
        ),
        CONSTRAINT "ck_auth_login_requests_processing_fields" CHECK (
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
        ),
        CONSTRAINT "ck_auth_login_requests_exchange_ready_fields" CHECK (
          "status" <> 'exchange_ready' OR (
            "code_challenge" IS NOT NULL AND "method" IS NOT NULL AND "method" = 'S256'
            AND "launch_ticket_hash" IS NULL
            AND "verified_subject" IS NOT NULL AND "exchange_code_hash" IS NOT NULL
            AND "code_expires_at" IS NOT NULL AND "consumed_at" IS NULL
          )
        ),
        CONSTRAINT "ck_auth_login_requests_consumed_fields" CHECK (
          "status" <> 'consumed' OR (
            "code_challenge" IS NULL AND "method" IS NULL AND "launch_ticket_hash" IS NULL
            AND "state_hash" IS NULL AND "browser_binding_hash" IS NULL AND "oidc_nonce_hash" IS NULL
            AND "provider_pkce_ciphertext" IS NULL AND "provider_pkce_iv" IS NULL
            AND "provider_pkce_tag" IS NULL AND "provider_pkce_key_id" IS NULL
            AND "verified_subject" IS NULL AND "exchange_code_hash" IS NULL
            AND "code_expires_at" IS NULL AND "consumed_at" IS NOT NULL
          )
        ),
        CONSTRAINT "ck_auth_login_requests_failed_fields" CHECK (
          "status" <> 'failed' OR (
            "code_challenge" IS NULL AND "method" IS NULL AND "launch_ticket_hash" IS NULL
            AND "state_hash" IS NULL AND "browser_binding_hash" IS NULL AND "oidc_nonce_hash" IS NULL
            AND "provider_pkce_ciphertext" IS NULL AND "provider_pkce_iv" IS NULL
            AND "provider_pkce_tag" IS NULL AND "provider_pkce_key_id" IS NULL
            AND "verified_subject" IS NULL AND "exchange_code_hash" IS NULL
            AND "code_expires_at" IS NULL AND "consumed_at" IS NULL
          )
        )
      );
      CREATE INDEX "idx_auth_login_requests_expires_at" ON "auth_login_requests" ("expires_at");
    `)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE "auth_login_requests";
      DROP TABLE "auth_refresh_tokens";
      DROP TABLE "auth_sessions";
      DROP TABLE "users";
    `)
  }
}
