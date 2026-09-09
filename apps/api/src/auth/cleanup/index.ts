import type { DataSource } from 'typeorm'
import { LOGIN } from '../../constants/login.js'
import { AuthSessionSchema } from '../../database/schemas/auth-sessions.js'
import { AuthLoginRequestSchema } from '../../database/schemas/auth-login-requests.js'
import { freshTime } from '../login/state.js'
import { cleanupFailure } from './errors.js'

export interface CleanupResult {
  sessionsDeleted: number
  loginRequestsDeleted: number
}

type SessionHint = { id: string; userId: string }

async function deleteEndedSession(source: DataSource, hint: SessionHint): Promise<number> {
  return source.transaction('READ COMMITTED', async (manager) => {
    const sessions = manager.getRepository(AuthSessionSchema)
    const session = await sessions.findOne({
      where: { id: hint.id },
      lock: { mode: 'pessimistic_write' }
    })
    const hasSession = session != null
    const hasSameOwner = hasSession && session.userId === hint.userId
    if (!hasSameOwner) {
      return 0
    }

    // 후보 조회 중 활동이 먼저 commit할 수 있으므로 잠금 뒤 새 시각과 현재 row로 재판정한다.
    const checkedAt = await freshTime(manager)
    const idleDeadline = session.lastActiveAt.getTime() + LOGIN.idleSeconds * 1000
    const isRevoked = session.revokedAt != null
    const isIdleExpired = checkedAt.getTime() >= idleDeadline
    const hasEnded = isRevoked || isIdleExpired
    if (!hasEnded) {
      return 0
    }

    // FK cascade가 현재 연결된 refresh 전체를 제거한다. 이 transaction은 user를 뒤에 잠그지 않는다.
    const deleted = await sessions.delete({ id: session.id, userId: hint.userId })
    return deleted.affected ?? 0
  })
}

async function deleteEndedRequest(source: DataSource, id: string): Promise<number> {
  return source.transaction('READ COMMITTED', async (manager) => {
    const requests = manager.getRepository(AuthLoginRequestSchema)
    const request = await requests.findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' }
    })
    const hasRequest = request != null
    if (!hasRequest) {
      return 0
    }

    const checkedAt = await freshTime(manager)
    const isConsumed = request.status === 'consumed'
    const isFailed = request.status === 'failed'
    const isRequestExpired = checkedAt.getTime() >= request.expiresAt.getTime()
    const hasEnded = isConsumed || isFailed || isRequestExpired
    if (!hasEnded) {
      return 0
    }

    // Code TTL은 교환 자격이다. 물리 삭제는 전체 request TTL 또는 terminal 전이로 판단한다.
    const deleted = await requests.delete({ id: request.id })
    return deleted.affected ?? 0
  })
}

/** 호출자의 초기화된 DataSource를 사용한다. 연결 수명과 주기 실행은 호출자의 책임이다. */
export async function cleanupAuthentication(source: DataSource): Promise<CleanupResult> {
  try {
    const endedSessionCandidatesSql = `SELECT id, user_id AS "userId" FROM auth_sessions
      WHERE revoked_at IS NOT NULL
         OR last_active_at <= to_timestamp(floor(extract(epoch from clock_timestamp()))) - $1 * interval '1 second'
      ORDER BY id`
    const sessions = (await source.query(endedSessionCandidatesSql, [
      LOGIN.idleSeconds
    ])) as SessionHint[]
    let sessionsDeleted = 0
    for (const hint of sessions) {
      sessionsDeleted += await deleteEndedSession(source, hint)
    }

    const endedRequestCandidatesSql = `SELECT id FROM auth_login_requests
      WHERE status IN ('consumed', 'failed')
         OR expires_at <= to_timestamp(floor(extract(epoch from clock_timestamp())))
      ORDER BY id`
    const requests = (await source.query(endedRequestCandidatesSql)) as Array<{ id: string }>
    let loginRequestsDeleted = 0
    for (const request of requests) {
      loginRequestsDeleted += await deleteEndedRequest(source, request.id)
    }

    return { sessionsDeleted, loginRequestsDeleted }
  } catch {
    // 앞선 row의 commit과 마지막 commit의 결과 불명이 남을 수 있다. 성공·전체 rollback을 추정하지 않는다.
    throw cleanupFailure()
  }
}
