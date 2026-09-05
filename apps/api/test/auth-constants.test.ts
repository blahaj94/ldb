import assert from 'node:assert/strict'
import test from 'node:test'

interface ErrorDefinition { code: string; status: number; message: string }
interface AuthConstants {
  AUTH_PROVIDERS: { GOOGLE: 'google'; DISCORD: 'discord' }
  AUTH_ERRORS: { INTERNAL: ErrorDefinition; UNAVAILABLE: ErrorDefinition }
  INITIAL_NICKNAME: { prefix: string; digits: number }
  REFRESH_TOKEN: { byteLength: number; encoding: string; hashAlgorithm: string }
}
async function constants(): Promise<AuthConstants> {
  return import(new URL('../src/constants/auth.js', import.meta.url).href) as Promise<AuthConstants>
}

test('auth constants preserve approved provider nickname and refresh values', async () => {
  const values = await constants()
  assert.deepEqual(values.AUTH_PROVIDERS, { GOOGLE: 'google', DISCORD: 'discord' })
  assert.deepEqual(values.INITIAL_NICKNAME, { prefix: '모험가', digits: 6 })
  assert.deepEqual(values.REFRESH_TOKEN, { byteLength: 32, encoding: 'base64url', hashAlgorithm: 'sha256' })
})

test('identity session errors derive their code status and text from one definition', async () => {
  const { AUTH_ERRORS } = await constants()
  const { IdentitySessionFailure } = await import(
    new URL('../src/errors/identity-session.js', import.meta.url).href
  ) as { IdentitySessionFailure: new (definition: ErrorDefinition) => Error & { code: string; status: number } }
  const expected = [
    { code: 'AUTH_INTERNAL_ERROR', status: 500, message: '인증 요청을 처리하지 못했습니다.' },
    { code: 'AUTH_UNAVAILABLE', status: 503, message: '현재 계정 기능을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.' },
  ]
  assert.deepEqual(Object.values(AUTH_ERRORS), expected)
  for (const definition of Object.values(AUTH_ERRORS)) {
    const error = new IdentitySessionFailure(definition)
    assert.deepEqual({ code: error.code, status: error.status, message: error.message }, definition)
    assert.equal(error.name, 'IdentitySessionFailure')
    assert.equal(error.cause, undefined)
  }
})
