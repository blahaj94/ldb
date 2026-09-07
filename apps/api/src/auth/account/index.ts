import type { EntityManager } from 'typeorm'
import { LOGIN } from '../../constants/login.js'
import { AuthSessionSchema } from '../../database/schemas/auth-sessions.js'
import { UserSchema } from '../../database/schemas/users.js'
import type { AccessJwtPrincipal, VerifyAccessJwt } from '../access-jwt/types.js'
import { ACCOUNT_ERRORS, AccountFailure } from './errors.js'
import { validateNickname } from './nickname.js'
import type { AccountDependencies, AccountHttpService, AccountProfile } from './types.js'

async function authenticate(
  verify: VerifyAccessJwt,
  rawHeaders: readonly string[],
): Promise<AccessJwtPrincipal> {
  const authorizations = rawHeaders.flatMap((value, index) => {
    const isName = index % 2 === 0
    const isAuthorization = isName && value.toLowerCase() === 'authorization'
    return isAuthorization ? [rawHeaders[index + 1]] : []
  })
  const hasOneAuthorization = authorizations.length === 1
  if (!hasOneAuthorization) throw new AccountFailure(ACCOUNT_ERRORS.AUTHENTICATION_REQUIRED)

  const bearer = /^Bearer ([^\s,]+)$/.exec(authorizations[0])
  const hasBearer = bearer != null
  if (!hasBearer) throw new AccountFailure(ACCOUNT_ERRORS.AUTHENTICATION_REQUIRED)

  try {
    return await verify(bearer[1], Math.floor(Date.now() / 1000))
  } catch {
    throw new AccountFailure(ACCOUNT_ERRORS.AUTHENTICATION_REQUIRED)
  }
}

function nicknameFromBody(body: unknown): string {
  const isObject = body != null && typeof body === 'object'
  const isArray = Array.isArray(body)
  const isRecord = isObject && !isArray
  if (!isRecord) throw new AccountFailure(ACCOUNT_ERRORS.INVALID_REQUEST)

  const hasNickname = Object.hasOwn(body, 'nickname')
  const hasOneField = Object.keys(body).length === 1
  const isNicknameBody = hasNickname && hasOneField
  if (!isNicknameBody) throw new AccountFailure(ACCOUNT_ERRORS.INVALID_REQUEST)
  return validateNickname(Reflect.get(body, 'nickname'))
}

async function lockActiveAccount(manager: EntityManager, principal: AccessJwtPrincipal) {
  const user = await manager.getRepository(UserSchema).findOne({
    select: { id: true, nickname: true },
    where: { id: principal.userId },
    lock: { mode: 'pessimistic_write' },
  })
  const hasUser = user != null
  if (!hasUser) throw new AccountFailure(ACCOUNT_ERRORS.AUTHENTICATION_REQUIRED)

  const session = await manager.getRepository(AuthSessionSchema).findOne({
    where: { id: principal.sessionId, userId: user.id },
    lock: { mode: 'pessimistic_write' },
  })
  const hasSession = session != null
  if (!hasSession) throw new AccountFailure(ACCOUNT_ERRORS.AUTHENTICATION_REQUIRED)

  // User→session의 모든 잠금 대기 뒤 fresh DB 정수 초를 읽어 두 단계 각각 재검사한다.
  const [clock] = await manager.query(
    'SELECT to_timestamp(floor(extract(epoch from clock_timestamp()))) AS now',
  ) as Array<{ now: Date }>
  const checkedAt = clock.now
  const checkedAtSeconds = checkedAt.getTime() / 1000
  const idleDeadline = session.lastActiveAt.getTime() / 1000 + LOGIN.idleSeconds
  const isRevoked = session.revokedAt != null
  const isIdleExpired = checkedAtSeconds >= idleDeadline
  const isInactive = isRevoked || isIdleExpired
  if (isInactive) throw new AccountFailure(ACCOUNT_ERRORS.AUTHENTICATION_REQUIRED)
  return { user, session, checkedAt, checkedAtSeconds }
}

type AccountOperation = { kind: 'read' } | { kind: 'nickname'; nickname: string }

async function runAccountOperation(
  deps: AccountDependencies,
  principal: AccessJwtPrincipal,
  operation: AccountOperation,
): Promise<AccountProfile> {
  try {
    await deps.dataSource.transaction('READ COMMITTED', async (manager) => {
      const { session, checkedAt, checkedAtSeconds } = await lockActiveAccount(manager, principal)
      const isJwtNotYetIssued = principal.issuedAt > checkedAtSeconds
      const isJwtExpired = checkedAtSeconds >= principal.expiresAt
      const isJwtInvalidAtAdmission = isJwtNotYetIssued || isJwtExpired
      if (isJwtInvalidAtAdmission) throw new AccountFailure(ACCOUNT_ERRORS.AUTHENTICATION_REQUIRED)

      const lastActiveAt = new Date(Math.max(session.lastActiveAt.getTime(), checkedAt.getTime()))
      await manager.getRepository(AuthSessionSchema).update({ id: session.id }, { lastActiveAt })
    })

    // 활동 commit이 확인된 다음 기능 transaction을 연다. 기능 실패로 인정한 활동을 되돌리지 않는다.
    return await deps.dataSource.transaction('READ COMMITTED', async (manager) => {
      const { user } = await lockActiveAccount(manager, principal)
      // JWT는 admission에서 판정했다. 여기서는 logout·삭제·idle을 재확인하고 JWT 경과만으로 거절하지 않는다.
      const shouldUpdateNickname = operation.kind === 'nickname'
      if (shouldUpdateNickname) {
        await manager.getRepository(UserSchema).update({ id: user.id }, { nickname: operation.nickname })
        user.nickname = operation.nickname
      }
      return { user: { id: user.id, nickname: user.nickname } }
    })
  } catch (error) {
    const isAccountFailure = error instanceof AccountFailure
    if (isAccountFailure) throw error
    // Read/write와 commit acknowledgement 불명은 정제 503이다. 자동 retry나 rollback 확정 주장을 하지 않는다.
    throw new AccountFailure(ACCOUNT_ERRORS.UNAVAILABLE)
  }
}

export function createAccountService(dependencies: AccountDependencies): AccountHttpService {
  const deps = Object.freeze({ ...dependencies })
  return {
    async get(rawHeaders) {
      const principal = await authenticate(deps.verifyAccessJwt, rawHeaders)
      return runAccountOperation(deps, principal, { kind: 'read' })
    },
    async updateNickname(rawHeaders, body) {
      const principal = await authenticate(deps.verifyAccessJwt, rawHeaders)
      const nickname = nicknameFromBody(body)
      return runAccountOperation(deps, principal, { kind: 'nickname', nickname })
    },
  }
}
