import type { DataSource, EntityManager } from 'typeorm'
import { AuthLoginRequestSchema } from '../../database/schemas/auth-login-requests.js'
import type { AuthLoginRequest } from '../../database/schemas/auth-login-requests.js'
import { CLEARED_LOGIN_FIELDS, LOGIN, LOGIN_ERRORS } from '../../constants/login.js'
import { loginFailure } from '../../errors/login.js'
import { decodeOpaque, equalHash, opaqueHash } from './crypto.js'

/** 단순 transaction의 오류를 정제한다. 정리 commit 후 거절하는 결과는 각 호출부에서 처리한다. */
export async function loginTransaction<T>(
  source: DataSource,
  operation: (manager: EntityManager) => Promise<T>
): Promise<T> {
  try {
    return await source.transaction('READ COMMITTED', operation)
  } catch (error) {
    // Commit 응답 유실·release 실패도 결과를 폐기한다. Token 재전달/retry 경로는 없다.
    throw loginFailure(error, LOGIN_ERRORS.UNAVAILABLE)
  }
}

export async function freshTime(manager: EntityManager): Promise<Date> {
  const [clock] = (await manager.query(
    'SELECT to_timestamp(floor(extract(epoch from clock_timestamp()))) AS now'
  )) as Array<{ now: Date }>
  return clock.now
}

export function requestExpired(request: AuthLoginRequest, checkedAt: Date): boolean {
  const isPastRequestExpiry = checkedAt.getTime() >= request.expiresAt.getTime()
  return isPastRequestExpiry
}

export function exchangeExpired(request: AuthLoginRequest, checkedAt: Date): boolean {
  const isRequestExpired = requestExpired(request, checkedAt)
  if (isRequestExpired) {
    return true
  }

  const hasNoCodeExpiry = request.codeExpiresAt === null
  if (hasNoCodeExpiry) {
    return true
  }

  // Null 검사 뒤에도 시간 조회 다음에 property를 다시 읽는 기존 순서를 유지한다.
  const isPastCodeExpiry = checkedAt.getTime() >= (request.codeExpiresAt as Date).getTime()
  const isExchangeExpired = isPastCodeExpiry

  return isExchangeExpired
}

export async function markLoginRequestFailed(
  manager: EntityManager,
  requestId: string
): Promise<void> {
  await manager.getRepository(AuthLoginRequestSchema).update(
    { id: requestId },
    {
      ...CLEARED_LOGIN_FIELDS,
      status: 'failed',
      consumedAt: null
    }
  )
}

export function browserCookie(id: string, value: string, seconds: number): string {
  return [
    `${LOGIN.cookiePrefix}${id}=${value}`,
    `Max-Age=${seconds}`,
    'Secure',
    'HttpOnly',
    'SameSite=Lax',
    'Path=/'
  ].join('; ')
}

export function cookieMatches(request: AuthLoginRequest, header: string): boolean {
  try {
    const cookieName = `${LOGIN.cookiePrefix}${request.id}`
    const matches = header
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.split('=')[0] === cookieName)

    // 중복된 요청 cookie는 어느 값을 선택하지 않고 binding 실패로 처리한다.
    const hasSingleCookieMatch = matches.length === 1
    if (!hasSingleCookieMatch) {
      return false
    }
    const value = matches[0].slice(cookieName.length + 1)
    decodeOpaque(value)
    return equalHash(request.browserBindingHash, opaqueHash(value))
  } catch {
    return false
  }
}
