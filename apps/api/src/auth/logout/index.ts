import type { DataSource } from 'typeorm'
import { LOGIN } from '../../constants/login.js'
import { AuthRefreshTokenSchema } from '../../database/schemas/auth-refresh-tokens.js'
import { AuthSessionSchema } from '../../database/schemas/auth-sessions.js'
import { UserSchema } from '../../database/schemas/users.js'
import { refreshTokenHash } from '../refresh/index.js'
import { LOGOUT_ERRORS, LogoutFailure } from './errors.js'

export { LogoutFailure } from './errors.js'

/** 제출한 canonical refresh token이 식별한 한 session만 종료한다. */
export async function logoutSession(dataSource: DataSource, rawToken: unknown): Promise<void> {
  // Format 실패는 DB unknown과 구분되는 요청 오류이며 refresh core와 같은 검증을 재사용한다.
  const presentedHash = refreshTokenHash(rawToken)

  try {
    await dataSource.transaction('READ COMMITTED', async (manager) => {
      const users = manager.getRepository(UserSchema)
      const sessions = manager.getRepository(AuthSessionSchema)
      const refresh = manager.getRepository(AuthRefreshTokenSchema)

      // 잠금 없는 조회는 잠글 ID의 hint일 뿐이며 unknown token은 어떤 session도 선택하지 않는다.
      const tokenHint = await refresh.findOneBy({ tokenHash: presentedHash })
      const hasTokenHint = tokenHint != null
      if (!hasTokenHint) return

      const sessionHint = await sessions.findOneBy({ id: tokenHint.sessionId })
      const hasSessionHint = sessionHint != null
      if (!hasSessionHint) return

      const user = await users.findOne({
        where: { id: sessionHint.userId },
        lock: { mode: 'pessimistic_write' },
      })
      const hasUser = user != null
      if (!hasUser) return

      const session = await sessions.findOne({
        where: { id: sessionHint.id },
        lock: { mode: 'pessimistic_write' },
      })
      const token = await refresh.findOne({
        where: { tokenHash: presentedHash },
        lock: { mode: 'pessimistic_write' },
      })

      const hasSession = session != null
      const hasToken = token != null
      const hasSameSessionOwner = hasSession && session.userId === user.id
      const hasSameTokenOwner = hasToken && token.sessionId === session?.id
      const hasSameTokenHash = hasToken && token.tokenHash.equals(presentedHash)
      const hasTrustedTarget =
        hasSession && hasToken && hasSameSessionOwner && hasSameTokenOwner && hasSameTokenHash
      if (!hasTrustedTarget) return

      const isAlreadyRevoked = session.revokedAt != null
      if (isAlreadyRevoked) return

      // 모든 대상 잠금 뒤의 DB 정수 초로 idle 종료와 revocation 시각을 판단한다.
      const [clock] = await manager.query(
        'SELECT to_timestamp(floor(extract(epoch from clock_timestamp()))) AS now',
      ) as Array<{ now: Date }>
      const checkedAt = clock.now
      const checkedAtSeconds = checkedAt.getTime() / 1000
      const idleDeadline = session.lastActiveAt.getTime() / 1000 + LOGIN.idleSeconds
      const isIdleEnded = checkedAtSeconds >= idleDeadline
      if (isIdleEnded) return

      await sessions.update(
        { id: session.id },
        { revokedAt: checkedAt, revokedReason: 'logout' },
      )
    })
  } catch (error) {
    // DB/commit 결과 불명은 원문 상세와 성공 204 없이 정제한다. 자동 retry하지 않는다.
    const isLogoutFailure = error instanceof LogoutFailure
    if (isLogoutFailure) throw error
    throw new LogoutFailure(LOGOUT_ERRORS.UNAVAILABLE)
  }
}
