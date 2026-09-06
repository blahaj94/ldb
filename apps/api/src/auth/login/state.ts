import type { DataSource, EntityManager } from 'typeorm'
import { AuthLoginRequestSchema } from '../../database/schemas/auth-login-requests.js'
import type { AuthLoginRequest } from '../../database/schemas/auth-login-requests.js'
import { CLEARED_LOGIN_FIELDS, LOGIN, LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure, loginFailure } from '../../errors/login.js'
import type { LoginRegistry } from './registry.js'
import { decodeOpaque, equalHash, opaqueHash } from './crypto.js'

/** Failure 반환은 terminal 정리를 commit한다. Throw는 호출자 쓰기까지 rollback한다. */
export async function loginTransaction<T>(
  source: DataSource,
  operation: (manager: EntityManager) => Promise<T | LoginFailure>,
): Promise<T> {
  try {
    const result = await source.transaction('READ COMMITTED', operation)
    if (result instanceof LoginFailure) {
      throw result
    }
    return result
  } catch (error) {
    // Commit 응답 유실·release 실패도 결과를 폐기한다. Token 재전달/retry 경로는 없다.
    throw loginFailure(error, LOGIN_ERRORS.UNAVAILABLE)
  }
}

export async function freshTime(manager: EntityManager): Promise<Date> {
  const [clock] = await manager.query(
    'SELECT to_timestamp(floor(extract(epoch from clock_timestamp()))) AS now',
  ) as Array<{ now: Date }>
  return clock.now
}

export function requestExpired(request: AuthLoginRequest, checkedAt: Date): boolean {
  return checkedAt.getTime() >= request.expiresAt.getTime()
}

export function exchangeExpired(request: AuthLoginRequest, checkedAt: Date): boolean {
  return requestExpired(request, checkedAt) ||
    request.codeExpiresAt === null ||
    checkedAt.getTime() >= request.codeExpiresAt.getTime()
}

export async function markLoginRequestFailed(
  manager: EntityManager,
  requestId: string,
): Promise<void> {
  await manager.getRepository(AuthLoginRequestSchema).update({ id: requestId }, {
    ...CLEARED_LOGIN_FIELDS,
    status: 'failed',
    consumedAt: null,
  })
}

export async function terminal(manager: EntityManager, row: AuthLoginRequest, consumedAt: Date | null = null): Promise<void> {
  await manager.getRepository(AuthLoginRequestSchema).update({ id: row.id }, {
    ...CLEARED_LOGIN_FIELDS, status: consumedAt ? 'consumed' : 'failed', consumedAt,
  })
}

export async function resolveRegistration(manager: EntityManager, row: AuthLoginRequest, registry: LoginRegistry) {
  try { return registry.resolve(row) } catch {
    await terminal(manager, row)
    return new LoginFailure(LOGIN_ERRORS.INTERNAL)
  }
}

export function browserCookie(id: string, value: string, seconds: number): string {
  return [
    `${LOGIN.cookiePrefix}${id}=${value}`,
    `Max-Age=${seconds}`,
    'Secure',
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
  ].join('; ')
}

export function cookieMatches(request: AuthLoginRequest, header: string): boolean {
  try {
    const cookieName = `${LOGIN.cookiePrefix}${request.id}`
    const matches = header.split(';')
      .map((part) => part.trim())
      .filter((part) => part.split('=')[0] === cookieName)

    // 중복된 요청 cookie는 어느 값을 선택하지 않고 binding 실패로 처리한다.
    if (matches.length !== 1) {
      return false
    }
    const value = matches[0].slice(cookieName.length + 1)
    decodeOpaque(value)
    return equalHash(request.browserBindingHash, opaqueHash(value))
  } catch {
    return false
  }
}
