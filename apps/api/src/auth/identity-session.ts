import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { EntityManager } from 'typeorm'
import { AuthRefreshTokenSchema } from '../database/schemas/auth-refresh-tokens.js'
import { AuthSessionSchema } from '../database/schemas/auth-sessions.js'
import { UserSchema } from '../database/schemas/users.js'
import { AUTH_ERRORS, AUTH_PROVIDERS, INITIAL_NICKNAME, REFRESH_TOKEN } from '../constants/auth.js'
import { IdentitySessionFailure } from '../errors/identity-session.js'
import type { IdentitySession, IdentitySessionEntropy, VerifiedIdentity } from '../types/auth.js'

export { IdentitySessionFailure } from '../errors/identity-session.js'
export type { IdentitySession, VerifiedIdentity } from '../types/auth.js'

const nativeEntropy: IdentitySessionEntropy = {
  uuid: randomUUID,
  nicknameNumber: randomInt,
  refreshBytes: randomBytes
}

const databaseTimeExpression = 'to_timestamp(floor(extract(epoch from clock_timestamp())))'

function generate<T>(operation: () => T): T {
  try {
    return operation()
  } catch {
    throw new IdentitySessionFailure(AUTH_ERRORS.INTERNAL)
  }
}

async function create({
  manager,
  identity,
  entropy
}: {
  manager: EntityManager
  identity: VerifiedIdentity
  entropy: IdentitySessionEntropy
}): Promise<IdentitySession> {
  try {
    const isTransactionActive = manager.queryRunner?.isTransactionActive === true
    if (!isTransactionActive) {
      throw new IdentitySessionFailure(AUTH_ERRORS.INTERNAL)
    }
    const isProviderSupported = Object.values(AUTH_PROVIDERS).some(
      (provider) => provider === identity.provider
    )
    if (!isProviderSupported) {
      throw new IdentitySessionFailure(AUTH_ERRORS.INTERNAL)
    }
    const isSubjectString = typeof identity.subject === 'string'
    if (!isSubjectString) {
      throw new IdentitySessionFailure(AUTH_ERRORS.INTERNAL)
    }
    const hasSubject = identity.subject.length !== 0
    if (!hasSubject) {
      throw new IdentitySessionFailure(AUTH_ERRORS.INTERNAL)
    }
    const [isolation] = (await manager.query('SHOW transaction_isolation')) as Array<{
      transaction_isolation: string
    }>
    const isReadCommitted = isolation?.transaction_isolation === 'read committed'
    if (!isReadCommitted) {
      throw new IdentitySessionFailure(AUTH_ERRORS.INTERNAL)
    }

    const users = manager.getRepository(UserSchema)
    const lookup = {
      where: { provider: identity.provider, providerSubject: identity.subject },
      lock: { mode: 'pessimistic_write' as const }
    }
    const existingUser = await users.findOne(lookup)
    let user: NonNullable<typeof existingUser>
    let isNewUser = false
    const isUserMissing = existingUser == null
    if (isUserMissing) {
      const id = generate(() => entropy.uuid())
      const nickname = generate(() => {
        const digits = String(entropy.nicknameNumber(0, 10 ** INITIAL_NICKNAME.digits))
        return `${INITIAL_NICKNAME.prefix}${digits.padStart(INITIAL_NICKNAME.digits, '0')}`
      })
      // 빈 overwrite 목록은 명시한 identity 충돌에만 DO NOTHING을 생성한다.
      const inserted = await users
        .createQueryBuilder()
        .insert()
        .values({
          id,
          provider: identity.provider,
          providerSubject: identity.subject,
          nickname,
          createdAt: () => databaseTimeExpression
        })
        .orUpdate([], ['provider', 'provider_subject'])
        .returning(['id'])
        // 기존 raw INSERT처럼 hook·입력 entity 자동 갱신·추가 조회를 수행하지 않는다.
        .callListeners(false)
        .updateEntity(false)
        .execute()
      isNewUser = (inserted.raw as Array<{ id: string }>).length === 1
      // READ COMMITTED의 다음 statement로 insert 대기 중 commit된 winner를 읽는다.
      const insertedUser = await users.findOne(lookup)
      const isWinnerMissing = insertedUser == null
      if (isWinnerMissing) {
        throw new IdentitySessionFailure(AUTH_ERRORS.UNAVAILABLE)
      }
      user = insertedUser
    } else {
      user = existingUser
    }

    const [clock] = (await manager.query(`SELECT ${databaseTimeExpression} AS now`)) as Array<{
      now: Date
    }>
    const issuedAt = clock.now
    if (isNewUser) {
      // INSERT의 unique 대기가 끝난 뒤 획득한 fresh 시각으로 새 회원도 확정한다.
      await users.update({ id: user.id }, { createdAt: issuedAt })
    }
    const sessionId = generate(() => entropy.uuid())
    const bytes = generate(() => entropy.refreshBytes(REFRESH_TOKEN.byteLength))
    const refreshToken = bytes.toString(REFRESH_TOKEN.encoding)
    const tokenHash = createHash(REFRESH_TOKEN.hashAlgorithm).update(bytes).digest()
    await manager.getRepository(AuthSessionSchema).insert({
      id: sessionId,
      userId: user.id,
      createdAt: issuedAt,
      lastActiveAt: issuedAt,
      revokedAt: null,
      revokedReason: null
    })
    await manager.getRepository(AuthRefreshTokenSchema).insert({
      tokenHash,
      sessionId,
      issuedAt,
      consumedAt: null
    })
    return {
      user: { id: user.id, nickname: user.nickname },
      session: { id: sessionId, createdAt: issuedAt, lastActiveAt: issuedAt },
      refreshToken,
      isNewUser
    }
  } catch (error) {
    // QueryFailedError의 SQL/parameters·identity를 호출자나 log에 전달하지 않는다.
    const isIdentitySessionFailure = error instanceof IdentitySessionFailure
    if (isIdentitySessionFailure) {
      throw error
    }
    throw new IdentitySessionFailure(AUTH_ERRORS.UNAVAILABLE)
  }
}

/**
 * 호출자의 active READ COMMITTED transaction에 합성한다. OAuth row 잠금은 호출자가 먼저 한다.
 * 오류는 transaction 밖으로 전파해 전체 rollback하며, commit 성공 후에만 반환 token을 전달한다.
 * Random 충돌도 전체 rollback 대상이다. 재시작 시 새 transaction과 새 entropy를 사용한다.
 */
export function createIdentitySession(
  manager: EntityManager,
  identity: VerifiedIdentity
): Promise<IdentitySession> {
  return create({ manager, identity, entropy: nativeEntropy })
}

/** 기존 adapter와 같은 test 전용 entropy 주입 경계. Runtime 설정으로 노출하지 않는다. */
export function createIdentitySessionForTest(
  manager: EntityManager,
  identity: VerifiedIdentity,
  entropy: Partial<IdentitySessionEntropy>
): Promise<IdentitySession> {
  return create({ manager, identity, entropy: { ...nativeEntropy, ...entropy } })
}
