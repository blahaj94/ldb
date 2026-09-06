import { createHash, randomBytes } from 'node:crypto'
import { REFRESH_TOKEN } from '../../constants/auth.js'
import { LOGIN } from '../../constants/login.js'
import { AuthRefreshTokenSchema } from '../../database/schemas/auth-refresh-tokens.js'
import { AuthSessionSchema } from '../../database/schemas/auth-sessions.js'
import { UserSchema } from '../../database/schemas/users.js'
import type { IssuedAccessJwt } from '../access-jwt/types.js'
import { REFRESH_ERRORS, RefreshFailure } from './errors.js'
import type { RefreshDependencies, RefreshTokens } from './types.js'

export { RefreshFailure } from './errors.js'
export type { RefreshDependencies, RefreshTokens } from './types.js'

type RefreshCommitResult =
  | { status: 'issued'; tokens: RefreshTokens }
  | { status: 'reuse-revoked' }

function tokenHash(rawToken: unknown): Buffer {
  if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) {
    throw new RefreshFailure(REFRESH_ERRORS.INVALID_REQUEST)
  }
  const bytes = Buffer.from(rawToken, REFRESH_TOKEN.encoding)
  if (bytes.length !== REFRESH_TOKEN.byteLength || bytes.toString(REFRESH_TOKEN.encoding) !== rawToken) {
    throw new RefreshFailure(REFRESH_ERRORS.INVALID_REQUEST)
  }
  return createHash(REFRESH_TOKEN.hashAlgorithm).update(bytes).digest()
}

async function rotate(
  deps: RefreshDependencies,
  rawToken: unknown,
  refreshBytes: (size: number) => Buffer,
): Promise<RefreshTokens> {
  const presentedHash = tokenHash(rawToken)

  try {
    const committed = await deps.dataSource.transaction<RefreshCommitResult>(
      'READ COMMITTED',
      async (manager) => {
        const users = manager.getRepository(UserSchema)
        const sessions = manager.getRepository(AuthSessionSchema)
        const refresh = manager.getRepository(AuthRefreshTokenSchema)

        // 잠금 없는 두 조회는 잠글 ID의 hint다. 아래 재조회 전에는 존재·소유·상태를 신뢰하지 않는다.
        const tokenHint = await refresh.findOneBy({ tokenHash: presentedHash })
        const sessionHint = tokenHint && await sessions.findOneBy({ id: tokenHint.sessionId })
        if (!tokenHint || !sessionHint) {
          throw new RefreshFailure(REFRESH_ERRORS.AUTHENTICATION_REQUIRED)
        }

        const user = await users.findOne({
          where: { id: sessionHint.userId },
          lock: { mode: 'pessimistic_write' },
        })
        if (!user) throw new RefreshFailure(REFRESH_ERRORS.AUTHENTICATION_REQUIRED)

        const session = await sessions.findOne({
          where: { id: sessionHint.id },
          lock: { mode: 'pessimistic_write' },
        })
        const token = await refresh.findOne({
          where: { tokenHash: presentedHash },
          lock: { mode: 'pessimistic_write' },
        })
        // 모든 잠금 대기가 끝난 뒤의 시각으로 idle 경계를 판단한다.
        const [clock] = await manager.query(
          'SELECT to_timestamp(floor(extract(epoch from clock_timestamp()))) AS now',
        ) as Array<{ now: Date }>
        const checkedAt = clock.now

        if (!session || !token || session.userId !== user.id || token.sessionId !== session.id ||
          !token.tokenHash.equals(presentedHash)) {
          throw new RefreshFailure(REFRESH_ERRORS.AUTHENTICATION_REQUIRED)
        }
        const issuedAt = checkedAt.getTime() / 1000
        const idleDeadline = session.lastActiveAt.getTime() / 1000 + LOGIN.idleSeconds
        if (session.revokedAt !== null || issuedAt >= idleDeadline) {
          throw new RefreshFailure(REFRESH_ERRORS.AUTHENTICATION_REQUIRED)
        }

        if (token.consumedAt !== null) {
          await sessions.update({ id: session.id }, {
            revokedAt: checkedAt,
            revokedReason: 'refresh_reuse',
          })
          // 여기서 throw하면 폐기까지 rollback된다. 폐기 commit을 확인한 뒤 밖에서 거절한다.
          return { status: 'reuse-revoked' }
        }

        let bytes: Buffer
        let accessJwt: IssuedAccessJwt
        try {
          bytes = refreshBytes(REFRESH_TOKEN.byteLength)
          if (!Buffer.isBuffer(bytes) || bytes.length !== REFRESH_TOKEN.byteLength) {
            throw new RefreshFailure(REFRESH_ERRORS.INTERNAL)
          }
          accessJwt = await deps.issueAccessJwt({
            userId: user.id,
            sessionId: session.id,
            issuedAt,
            idleDeadline,
          })
        } catch {
          throw new RefreshFailure(REFRESH_ERRORS.INTERNAL)
        }
        const nextHash = createHash(REFRESH_TOKEN.hashAlgorithm).update(bytes).digest()
        await refresh.update({ tokenHash: presentedHash }, { consumedAt: checkedAt })
        await refresh.insert({
          tokenHash: nextHash,
          sessionId: session.id,
          issuedAt: checkedAt,
          consumedAt: null,
        })

        return {
          status: 'issued',
          tokens: {
            tokenType: 'Bearer',
            accessToken: accessJwt.accessToken,
            accessTokenExpiresAt: new Date(accessJwt.expiresAt * 1000).toISOString(),
            refreshToken: bytes.toString(REFRESH_TOKEN.encoding),
            sessionExpiresAt: new Date(idleDeadline * 1000).toISOString(),
          },
        }
      },
    )

    // DataSource가 commit·release를 완료한 후에만 결과를 전달한다.
    if (committed.status === 'reuse-revoked') {
      throw new RefreshFailure(REFRESH_ERRORS.AUTHENTICATION_REQUIRED)
    }
    return committed.tokens
  } catch (error) {
    if (error instanceof RefreshFailure) throw error
    // DB 실패·random unique 충돌·commit 결과 불명은 원문 상세 없이 거절한다. 자동 retry하지 않는다.
    throw new RefreshFailure(REFRESH_ERRORS.UNAVAILABLE)
  }
}

/** HTTP 연결 전용 내부 core. 이 함수가 READ COMMITTED transaction과 commit 결과를 소유한다. */
export function rotateRefresh(deps: RefreshDependencies, rawToken: unknown): Promise<RefreshTokens> {
  return rotate(deps, rawToken, randomBytes)
}

/** Random 충돌·실패 검증용 주입 경계. Runtime 설정이나 HTTP 입력으로 노출하지 않는다. */
export function rotateRefreshForTest(
  deps: RefreshDependencies,
  rawToken: unknown,
  refreshBytes: (size: number) => Buffer,
): Promise<RefreshTokens> {
  return rotate(deps, rawToken, refreshBytes)
}
