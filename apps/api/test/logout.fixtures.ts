import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DataSource } from 'typeorm'

export const checkedAt = new Date('2026-09-06T00:00:00.000Z')

export function rawRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export function refreshTokenHash(rawToken: string): Buffer {
  return createHash('sha256').update(Buffer.from(rawToken, 'base64url')).digest()
}

type FixtureState = {
  tokenHintMissing: boolean
  sessionHintMissing: boolean
  userMissing: boolean
  sessionMissing: boolean
  tokenMissing: boolean
  beforeCommit?: () => Promise<void>
  transactionFailure?: Error
  commitFailure?: Error
}

export function logoutFixture() {
  const rawToken = rawRefreshToken()
  const user = { id: randomUUID() }
  const session = {
    id: randomUUID(),
    userId: user.id,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    lastActiveAt: new Date('2026-09-05T00:00:00.000Z'),
    revokedAt: null as Date | null,
    revokedReason: null as 'logout' | 'refresh_reuse' | null,
  }
  const token = {
    tokenHash: refreshTokenHash(rawToken),
    sessionId: session.id,
    issuedAt: new Date('2026-09-05T00:00:00.000Z'),
    consumedAt: null as Date | null,
  }
  const state: FixtureState = {
    tokenHintMissing: false,
    sessionHintMissing: false,
    userMissing: false,
    sessionMissing: false,
    tokenMissing: false,
  }
  const events: string[] = []

  const users = {
    findOne: async () => {
      events.push('user-lock')
      return state.userMissing ? null : user
    },
  }
  const sessions = {
    findOneBy: async () => {
      events.push('session-hint')
      return state.sessionHintMissing ? null : session
    },
    findOne: async () => {
      events.push('session-lock')
      return state.sessionMissing ? null : session
    },
    update: async (_criteria: unknown, update: { revokedAt: Date; revokedReason: 'logout' }) => {
      events.push('revoke')
      session.revokedAt = update.revokedAt
      session.revokedReason = update.revokedReason
    },
  }
  const refresh = {
    findOneBy: async () => {
      events.push('refresh-hint')
      return state.tokenHintMissing ? null : token
    },
    findOne: async () => {
      events.push('refresh-lock')
      return state.tokenMissing ? null : token
    },
  }
  const manager = {
    getRepository: (schema: { options: { name: string } }) => {
      if (schema.options.name === 'User') return users
      if (schema.options.name === 'AuthSession') return sessions
      return refresh
    },
    query: async () => {
      events.push('fresh-time')
      return [{ now: checkedAt }]
    },
  }
  const dataSource = {
    transaction: async (
      isolation: string,
      operation: (transactionManager: typeof manager) => Promise<void>,
    ) => {
      events.push('begin')
      if (state.transactionFailure != null) {
        throw state.transactionFailure
      }
      await operation(manager)
      if (state.beforeCommit != null) {
        await state.beforeCommit()
      }
      if (state.commitFailure != null) {
        throw state.commitFailure
      }
      events.push('commit')
      if (isolation !== 'READ COMMITTED') {
        throw new Error('unexpected isolation')
      }
    },
  } as unknown as DataSource

  return { dataSource, events, rawToken, session, state, token, user }
}
