import { EntitySchema } from 'typeorm'

export interface AuthSession {
  id: string
  userId: string
  createdAt: Date
  lastActiveAt: Date
  revokedAt: Date | null
  revokedReason: 'logout' | 'refresh_reuse' | null
}

export const AuthSessionSchema = new EntitySchema<AuthSession>({
  name: 'AuthSession',
  tableName: 'auth_sessions',
  columns: {
    id: { type: 'uuid', primary: true, primaryKeyConstraintName: 'pk_auth_sessions' },
    userId: { name: 'user_id', type: 'uuid' },
    createdAt: { name: 'created_at', type: 'timestamptz', precision: 0 },
    lastActiveAt: { name: 'last_active_at', type: 'timestamptz', precision: 0 },
    revokedAt: { name: 'revoked_at', type: 'timestamptz', precision: 0, nullable: true },
    revokedReason: { name: 'revoked_reason', type: 'text', nullable: true }
  },
  foreignKeys: [
    {
      name: 'fk_auth_sessions_user',
      target: 'User',
      columnNames: ['userId'],
      referencedColumnNames: ['id'],
      onDelete: 'CASCADE'
    }
  ],
  indices: [
    { name: 'idx_auth_sessions_user_id', columns: ['userId'] },
    { name: 'idx_auth_sessions_last_active_at', columns: ['lastActiveAt'] }
  ],
  checks: [
    { name: 'ck_auth_sessions_last_active', expression: `"last_active_at" >= "created_at"` },
    {
      name: 'ck_auth_sessions_revoked_pair',
      expression: `("revoked_at" IS NULL) = ("revoked_reason" IS NULL)`
    },
    {
      name: 'ck_auth_sessions_revoked_time',
      expression: `"revoked_at" IS NULL OR "revoked_at" >= "created_at"`
    },
    {
      name: 'ck_auth_sessions_revoked_reason',
      expression: `"revoked_reason" IS NULL OR "revoked_reason" IN ('logout', 'refresh_reuse')`
    }
  ]
})
