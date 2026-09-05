import { AUTH_PROVIDERS } from '../../constants/auth.js'
import { EntitySchema } from 'typeorm'
import type { AuthProvider } from '../../types/auth.js'

export interface User {
  id: string
  provider: AuthProvider
  providerSubject: string
  nickname: string
  createdAt: Date
}

export const UserSchema = new EntitySchema<User>({
  name: 'User',
  tableName: 'users',
  columns: {
    id: { type: 'uuid', primary: true, primaryKeyConstraintName: 'pk_users' },
    provider: { type: 'text' },
    providerSubject: { name: 'provider_subject', type: 'text', collation: 'C' },
    nickname: { type: 'text' },
    createdAt: { name: 'created_at', type: 'timestamptz', precision: 0 },
  },
  uniques: [
    { name: 'uq_users_provider_subject', columns: ['provider', 'providerSubject'] },
  ],
  checks: [
    { name: 'ck_users_provider', expression: `"provider" IN ('${AUTH_PROVIDERS.GOOGLE}', '${AUTH_PROVIDERS.DISCORD}')` },
    { name: 'ck_users_provider_subject_nonempty', expression: `char_length("provider_subject") > 0` },
    { name: 'ck_users_nickname_nonempty', expression: `char_length("nickname") > 0` },
  ],
})
