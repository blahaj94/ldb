import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { createIdentitySession } from '../dist/auth/identity-session.js'
import { createAccessJwtIssuer, createAccessJwtVerifier } from '../dist/auth/access-jwt/index.js'
import { rotateRefresh, rotateRefreshForTest } from '../dist/auth/refresh/index.js'
import { databaseNow } from './login-test-control.mjs'

export const idleSeconds = 2_592_000
export const digest = (raw) => createHash('sha256').update(Buffer.from(raw, 'base64url')).digest()
export const opaque = () => randomBytes(32).toString('base64url')

export async function rejected(operation, code = 'AUTHENTICATION_REQUIRED') {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code)
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(String(error.stack), /private detail|SQL detail/)
    return true
  })
}

export async function fixture(source, identity = { provider: 'google', subject: randomUUID() }) {
  const initial = await source.transaction('READ COMMITTED', (manager) =>
    createIdentitySession(manager, identity)
  )
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const configuration = {
    issuer: 'https://refresh.test.invalid',
    audience: 'refresh-test',
    verificationKeys: [
      { kid: 'fixture', publicKeyPem: keyPair.publicKey.export({ format: 'pem', type: 'spki' }) }
    ],
    signingKey: {
      kid: 'fixture',
      privateKeyPem: keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' })
    }
  }
  const issueAccessJwt = await createAccessJwtIssuer(configuration)
  const verifyJwt = await createAccessJwtVerifier(configuration)
  const deps = { dataSource: source, issueAccessJwt }
  return {
    initial,
    identity,
    deps,
    verifyJwt,
    rotate: (raw) => rotateRefresh(deps, raw),
    rotateWithBytes: (raw, bytes) => rotateRefreshForTest(deps, raw, bytes)
  }
}

export async function stored(source, sessionId) {
  return {
    session: (await source.query('SELECT * FROM auth_sessions WHERE id=$1', [sessionId]))[0],
    tokens: await source.query(
      'SELECT * FROM auth_refresh_tokens WHERE session_id=$1 ORDER BY token_hash',
      [sessionId]
    )
  }
}

export async function setDeadline(source, sessionId, deadline) {
  const lastActiveAt = new Date(deadline.getTime() - idleSeconds * 1000)
  await source.query('UPDATE auth_sessions SET created_at=$2, last_active_at=$2 WHERE id=$1', [
    sessionId,
    lastActiveAt
  ])
}

// 사용자/session/refresh 각 lock에서 실제 PostgreSQL 대기를 관측한다. Docker 수명주기는 공통 harness 소유다.
export async function withLock(source, kind, f, operation) {
  const runner = source.createQueryRunner()
  try {
    await runner.connect()
    await runner.startTransaction('READ COMMITTED')
    const [{ pid }] = await runner.query('SELECT pg_backend_pid() AS pid')
    const isUserLock = kind === 'users'
    if (isUserLock) {
      await runner.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [f.initial.user.id])
    } else {
      const isSessionLock = kind === 'auth_sessions'
      if (isSessionLock) {
        await runner.query('SELECT id FROM auth_sessions WHERE id=$1 FOR UPDATE', [
          f.initial.session.id
        ])
      } else {
        assert.equal(kind, 'auth_refresh_tokens')
        await runner.query(
          'SELECT token_hash FROM auth_refresh_tokens WHERE token_hash=$1 FOR UPDATE',
          [digest(f.initial.refreshToken)]
        )
      }
    }
    await operation({ runner, pid, unlock: () => runner.commitTransaction() })
  } finally {
    if (runner.isTransactionActive) {
      await runner.rollbackTransaction()
    }
    await runner.release()
  }
}

export async function revoke(manager, sessionId, reason = 'logout') {
  const checkedAt = await databaseNow(manager)
  await manager.query('UPDATE auth_sessions SET revoked_at=$2, revoked_reason=$3 WHERE id=$1', [
    sessionId,
    checkedAt,
    reason
  ])
}
