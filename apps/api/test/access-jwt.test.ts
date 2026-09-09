import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CompactSign,
  decodeJwt,
  decodeProtectedHeader,
  importPKCS8,
  importSPKI,
  jwtVerify
} from 'jose'
import { createAccessJwtIssuer, createAccessJwtVerifier } from '../src/auth/access-jwt/index.js'
import { AccessJwtError } from '../src/auth/access-jwt/errors.js'
import {
  active,
  claims,
  configuration,
  header,
  input,
  now,
  previous,
  sessionId,
  signed,
  tokenId,
  userId
} from './access-jwt.fixtures.js'

const isInvalidToken = (error: unknown) => {
  const isAccessJwtError = error instanceof AccessJwtError
  const hasInvalidTokenCode = isAccessJwtError && error.code === 'INVALID_ACCESS_JWT'
  const hasInvalidTokenMessage = hasInvalidTokenCode && error.message === 'Invalid access JWT'
  const hasNoCause = hasInvalidTokenMessage && !Object.hasOwn(error, 'cause')
  const isExpectedInvalidToken =
    isAccessJwtError && hasInvalidTokenCode && hasInvalidTokenMessage && hasNoCause
  return isExpectedInvalidToken
}

test('발급 token은 승인된 최소 claims만 담고 jose와 독립 verifier로 검증된다', async () => {
  const issue = await createAccessJwtIssuer(configuration())
  const verify = await createAccessJwtVerifier(configuration())
  const result = await issue(input())
  assert.deepEqual(decodeProtectedHeader(result.accessToken), header())
  const payload = decodeJwt(result.accessToken)
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'sid', 'sub'])
  assert.equal(payload.iat, now)
  assert.equal(payload.exp, now + 900)
  assert.equal(result.issuedAt, now)
  assert.equal(result.expiresAt, now + 900)
  assert.match(
    payload.jti as string,
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/
  )
  await jwtVerify(result.accessToken, await importSPKI(active.publicKeyPem, 'ES256'), {
    issuer: configuration().issuer,
    audience: configuration().audience,
    algorithms: ['ES256'],
    currentDate: new Date(now * 1000)
  })
  assert.deepEqual(await verify(result.accessToken, now), {
    userId,
    sessionId,
    issuedAt: now,
    expiresAt: now + 900,
    tokenId: payload.jti
  })
  const another = await issue(input())
  assert.ok(payload.jti !== decodeJwt(another.accessToken).jti)
})

for (const seconds of [1, 899, 900, 901, 2_592_000]) {
  test(`idle deadline ${seconds}초와 900초 상한 중 이른 exp를 선택한다`, async () => {
    const issue = await createAccessJwtIssuer(configuration())
    const verify = await createAccessJwtVerifier(configuration())
    const result = await issue({ ...input(), idleDeadline: now + seconds })
    const expected = now + Math.min(seconds, 900)
    assert.equal(result.expiresAt, expected)
    await verify(result.accessToken, expected - 1)
    await assert.rejects(verify(result.accessToken, expected), isInvalidToken)
    await assert.rejects(verify(result.accessToken, expected + 1), isInvalidToken)
    await assert.rejects(verify(result.accessToken, now - 1), isInvalidToken)
  })
}

test('부호가 유효한 이전 key token도 등록되어 있는 동안 검증한다', async () => {
  const verify = await createAccessJwtVerifier(configuration())
  const token = await signed(claims(), { ...header(), kid: previous.kid }, previous)
  assert.deepEqual(await verify(token, now), {
    userId,
    sessionId,
    issuedAt: now,
    expiresAt: now + 900,
    tokenId
  })
  const config = configuration()
  config.verificationKeys = [config.verificationKeys[0]]
  const removed = await createAccessJwtVerifier(config)
  await assert.rejects(removed(token, now), isInvalidToken)
})

test('발급 입력은 UUID와 UTC 정수 초를 요구하고 만료된 session은 발급하지 않는다', async () => {
  const issue = await createAccessJwtIssuer(configuration())
  const cases = [
    { userId: 'invalid' },
    { sessionId: '' },
    { issuedAt: now + 0.1 },
    { idleDeadline: now + 0.1 },
    { issuedAt: NaN },
    { idleDeadline: Infinity },
    { idleDeadline: now },
    { idleDeadline: now - 1 },
    { issuedAt: Number.MAX_SAFE_INTEGER }
  ]
  for (const value of cases) {
    await assert.rejects(issue({ ...input(), ...value }), (error: unknown) => {
      const isAccessJwtError = error instanceof AccessJwtError
      const hasInvalidInputCode = isAccessJwtError && error.code === 'INVALID_ACCESS_JWT_INPUT'
      const isInvalidInputFailure = isAccessJwtError && hasInvalidInputCode
      return isInvalidInputFailure
    })
  }
})

test('token 변조·다른 key 서명·malformed compact 입력을 거절한다', async () => {
  const verify = await createAccessJwtVerifier(configuration())
  const token = await signed()
  const parts = token.split('.')
  const changedPayload = Buffer.from(JSON.stringify({ ...claims(), sub: sessionId })).toString(
    'base64url'
  )
  const signature = Buffer.from(parts[2], 'base64url')
  signature[0] ^= 1
  const wrongKey = await signed(claims(), header(), previous)
  for (const candidate of [
    `${parts[0]}.${changedPayload}.${parts[2]}`,
    `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`,
    wrongKey,
    '',
    'broken',
    'a.b.c',
    `${token}.extra`,
    null,
    42,
    {}
  ]) {
    await assert.rejects(verify(candidate, now), isInvalidToken)
  }
})

for (const field of ['iss', 'aud', 'sub', 'sid', 'iat', 'exp', 'jti']) {
  test(`필수 ${field} 누락과 잘못된 type을 거절한다`, async () => {
    const verify = await createAccessJwtVerifier(configuration())
    const missing = claims()
    delete missing[field]
    await assert.rejects(verify(await signed(missing), now), isInvalidToken)
    for (const value of [null, {}, [], true]) {
      await assert.rejects(
        verify(await signed({ ...claims(), [field]: value }), now),
        isInvalidToken
      )
    }
  })
}

const invalidClaims: [string, Record<string, unknown>][] = [
  ['issuer 불일치', { iss: 'urn:other:issuer' }],
  ['audience 불일치', { aud: 'urn:other:api' }],
  ['audience array', { aud: [configuration().audience] }],
  ['복수 audience', { aud: [configuration().audience, 'other'] }],
  ['sub UUID', { sub: 'provider-subject' }],
  ['sid UUID', { sid: 'invalid' }],
  ['jti UUID', { jti: 'invalid' }],
  ['소수 iat', { iat: now - 0.1 }],
  ['소수 exp', { exp: now + 899.9 }],
  ['문자열 iat', { iat: String(now) }],
  ['문자열 exp', { exp: String(now + 900) }],
  ['미래 iat', { iat: now + 1 }],
  ['동일 iat exp', { iat: now, exp: now }],
  ['음수 lifetime', { exp: now - 1 }],
  ['초과 lifetime', { exp: now + 901 }],
  ['unsafe iat', { iat: -Number.MAX_SAFE_INTEGER - 1 }],
  ['과거 nbf', { nbf: now - 1 }],
  ['미래 nbf', { nbf: now + 1 }]
]
for (const [label, values] of invalidClaims) {
  test(`서명된 잘못된 claims 거절: ${label}`, async () => {
    const verify = await createAccessJwtVerifier(configuration())
    await assert.rejects(verify(await signed({ ...claims(), ...values }), now), isInvalidToken)
  })
}

for (const values of [
  { typ: undefined },
  { typ: 'JWT' },
  { typ: 'AT+JWT' },
  { typ: 'application/at+jwt' },
  { typ: 42 },
  { kid: undefined },
  { kid: '' },
  { kid: 'unknown' },
  { kid: 42 },
  { kid: 'toString' },
  { kid: '__proto__' }
]) {
  test(`잘못된 protected header 거절: ${JSON.stringify(values)}`, async () => {
    const verify = await createAccessJwtVerifier(configuration())
    await assert.rejects(
      verify(await signed(claims(), { ...header(), ...values }), now),
      isInvalidToken
    )
  })
}

test('비허용 alg와 token 제공 key/URL은 등록 key를 대체하지 못한다', async () => {
  const verify = await createAccessJwtVerifier(configuration())
  // 유효한 HMAC 서명이라도 verifier의 EC public key를 shared secret으로 재해석하지 않는다.
  const confused = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims())))
    .setProtectedHeader({ ...header(), alg: 'HS256' })
    .sign(new TextEncoder().encode(active.publicKeyPem))
  await assert.rejects(verify(confused, now), isInvalidToken)
  const token = await signed()
  const parts = token.split('.')
  for (const alg of ['none', 'HS256', 'ES384', 'RS256', undefined]) {
    const altered = Buffer.from(JSON.stringify({ ...header(), alg })).toString('base64url')
    await assert.rejects(verify(`${altered}.${parts[1]}.${parts[2]}`, now), isInvalidToken)
  }
  await assert.rejects(
    verify(
      await signed(claims(), {
        ...header(),
        kid: 'unknown',
        jku: 'https://invalid.example/jwks',
        jwk: { kty: 'EC' }
      }),
      now
    ),
    isInvalidToken
  )
})

test('미지원 crit 및 JSON object가 아닌 payload를 거절한다', async () => {
  const verify = await createAccessJwtVerifier(configuration())
  for (const payload of [null, [], 'text', 42]) {
    await assert.rejects(verify(await signed(payload), now), isInvalidToken)
  }
  const critical = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims())))
    .setProtectedHeader({ ...header(), crit: ['unknown'], unknown: true })
    .sign(await importPKCS8(active.privateKeyPem, 'ES256'), { crit: { unknown: true } })
  await assert.rejects(verify(critical, now), isInvalidToken)
})

test('verify 시간은 server의 정수 초이고 추가 claim은 principal에 전파하지 않는다', async () => {
  const verify = await createAccessJwtVerifier(configuration())
  const token = await signed({ ...claims(), custom: { role: 'admin' } })
  for (const badNow of [now + 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(verify(token, badNow), isInvalidToken)
  }
  assert.deepEqual(await verify(token, now), {
    userId,
    sessionId,
    issuedAt: now,
    expiresAt: now + 900,
    tokenId
  })
})
