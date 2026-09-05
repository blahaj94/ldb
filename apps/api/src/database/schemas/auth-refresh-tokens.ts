import { EntitySchema } from 'typeorm'
import type { Buffer } from 'node:buffer'

export interface AuthRefreshToken {
  tokenHash: Buffer
  sessionId: string
  issuedAt: Date
  consumedAt: Date | null
}

export const AuthRefreshTokenSchema = new EntitySchema<AuthRefreshToken>({
  name: 'AuthRefreshToken',
  tableName: 'auth_refresh_tokens',
  columns: {
    tokenHash: { name: 'token_hash', type: 'bytea', primary: true, primaryKeyConstraintName: 'pk_auth_refresh_tokens' },
    sessionId: { name: 'session_id', type: 'uuid' },
    issuedAt: { name: 'issued_at', type: 'timestamptz', precision: 0 },
    consumedAt: { name: 'consumed_at', type: 'timestamptz', precision: 0, nullable: true },
  },
  foreignKeys: [
    {
      name: 'fk_auth_refresh_tokens_session', target: 'AuthSession',
      columnNames: ['sessionId'], referencedColumnNames: ['id'], onDelete: 'CASCADE',
    },
  ],
  indices: [
    { name: 'uq_auth_refresh_tokens_unconsumed_session', columns: ['sessionId'], unique: true, where: '"consumed_at" IS NULL' },
    { name: 'idx_auth_refresh_tokens_session_id', columns: ['sessionId'] },
  ],
  checks: [
    { name: 'ck_auth_refresh_tokens_hash_length', expression: `octet_length("token_hash") = 32` },
    { name: 'ck_auth_refresh_tokens_consumed_time', expression: `"consumed_at" IS NULL OR "consumed_at" >= "issued_at"` },
  ],
})
