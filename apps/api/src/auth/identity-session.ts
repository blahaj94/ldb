import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { EntityManager } from 'typeorm'
import { AuthRefreshTokenSchema } from '../database/schemas/auth-refresh-tokens.js'
import { AuthSessionSchema } from '../database/schemas/auth-sessions.js'
import { UserSchema } from '../database/schemas/users.js'
import type { User } from '../database/schemas/users.js'

/** 서버의 provider 검증을 마친 identity만 전달한다. HTTP 입력 검증기는 아니다. */
export interface VerifiedIdentity {
  readonly provider: User['provider']
  readonly subject: string
}

export interface IdentitySession {
  user: Pick<User, 'id' | 'nickname'>
  session: { id: string; createdAt: Date; lastActiveAt: Date }
  refreshToken: string
  isNewUser: boolean
}

interface Entropy {
  uuid(): string
  nicknameNumber(min: number, max: number): number
  refreshBytes(size: number): Buffer
}

const nativeEntropy: Entropy = {
  uuid: randomUUID,
  nicknameNumber: randomInt,
  refreshBytes: randomBytes,
}

export class IdentitySessionFailure extends Error {
  readonly status: number

  constructor(readonly code: 'AUTH_INTERNAL_ERROR' | 'AUTH_UNAVAILABLE') {
    super(code === 'AUTH_INTERNAL_ERROR'
      ? '인증 요청을 처리하지 못했습니다.'
      : '현재 계정 기능을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.')
    this.name = 'IdentitySessionFailure'
    this.status = code === 'AUTH_INTERNAL_ERROR' ? 500 : 503
  }
}

function generate<T>(operation: () => T): T {
  try {
    return operation()
  } catch {
    throw new IdentitySessionFailure('AUTH_INTERNAL_ERROR')
  }
}

async function create(
  manager: EntityManager,
  identity: VerifiedIdentity,
  entropy: Entropy,
): Promise<IdentitySession> {
  try {
    if (!manager.queryRunner?.isTransactionActive ||
      (identity.provider !== 'google' && identity.provider !== 'discord') ||
      typeof identity.subject !== 'string' || identity.subject.length === 0) {
      throw new IdentitySessionFailure('AUTH_INTERNAL_ERROR')
    }
    const [isolation] = await manager.query('SHOW transaction_isolation') as Array<{ transaction_isolation: string }>
    if (isolation?.transaction_isolation !== 'read committed') {
      throw new IdentitySessionFailure('AUTH_INTERNAL_ERROR')
    }

    const users = manager.getRepository(UserSchema)
    const lookup = {
      where: { provider: identity.provider, providerSubject: identity.subject },
      lock: { mode: 'pessimistic_write' as const },
    }
    let user = await users.findOne(lookup)
    let isNewUser = false
    if (!user) {
      const id = generate(() => entropy.uuid())
      const nickname = generate(() => `모험가${String(entropy.nicknameNumber(0, 1_000_000)).padStart(6, '0')}`)
      // 기존 nickname을 쓰지 않는 명시적 conflict target. 경합 후보 중 winner만 저장된다.
      const inserted = await manager.query(`
        INSERT INTO users (id, provider, provider_subject, nickname, created_at)
        VALUES ($1, $2, $3, $4, to_timestamp(floor(extract(epoch from clock_timestamp()))))
        ON CONFLICT (provider, provider_subject) DO NOTHING RETURNING id
      `, [id, identity.provider, identity.subject, nickname]) as Array<{ id: string }>
      isNewUser = inserted.length === 1
      // READ COMMITTED의 다음 statement로 insert 대기 중 commit된 winner를 읽는다.
      user = await users.findOne(lookup)
      if (!user) throw new IdentitySessionFailure('AUTH_UNAVAILABLE')
    }

    const [clock] = await manager.query(
      'SELECT to_timestamp(floor(extract(epoch from clock_timestamp()))) AS now',
    ) as Array<{ now: Date }>
    const issuedAt = clock.now
    if (isNewUser) {
      // INSERT의 unique 대기가 끝난 뒤 획득한 fresh 시각으로 새 회원도 확정한다.
      await users.update({ id: user.id }, { createdAt: issuedAt })
    }
    const sessionId = generate(() => entropy.uuid())
    const bytes = generate(() => entropy.refreshBytes(32))
    const refreshToken = bytes.toString('base64url')
    const tokenHash = createHash('sha256').update(bytes).digest()
    await manager.getRepository(AuthSessionSchema).insert({
      id: sessionId,
      userId: user.id,
      createdAt: issuedAt,
      lastActiveAt: issuedAt,
      revokedAt: null,
      revokedReason: null,
    })
    await manager.getRepository(AuthRefreshTokenSchema).insert({
      tokenHash,
      sessionId,
      issuedAt,
      consumedAt: null,
    })
    return {
      user: { id: user.id, nickname: user.nickname },
      session: { id: sessionId, createdAt: issuedAt, lastActiveAt: issuedAt },
      refreshToken,
      isNewUser,
    }
  } catch (error) {
    // QueryFailedError의 SQL/parameters·identity를 호출자나 log에 전달하지 않는다.
    if (error instanceof IdentitySessionFailure) throw error
    throw new IdentitySessionFailure('AUTH_UNAVAILABLE')
  }
}

/**
 * 호출자의 active READ COMMITTED transaction에 합성한다. OAuth row 잠금은 호출자가 먼저 한다.
 * 오류는 transaction 밖으로 전파해 전체 rollback하며, commit 성공 후에만 반환 token을 전달한다.
 * Random 충돌도 전체 rollback 대상이다. 재시작 시 새 transaction과 새 entropy를 사용한다.
 */
export function createIdentitySession(manager: EntityManager, identity: VerifiedIdentity): Promise<IdentitySession> {
  return create(manager, identity, nativeEntropy)
}

/** 기존 adapter와 같은 test 전용 entropy 주입 경계. Runtime 설정으로 노출하지 않는다. */
export function createIdentitySessionForTest(
  manager: EntityManager,
  identity: VerifiedIdentity,
  entropy: Partial<Entropy>,
): Promise<IdentitySession> {
  return create(manager, identity, { ...nativeEntropy, ...entropy })
}
