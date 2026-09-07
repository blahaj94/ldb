/* global fetch */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { test } from 'node:test'
import { withAccountApp, rawAccountRequest, expectAccountError } from './account-http-fixtures.mjs'

test('GET account verifier failures are sanitized JSON without DB activity', async () => {
  let databaseCalls = 0
  const source = { transaction: async () => {
    databaseCalls++
    throw new Error('private database detail')
  } }
  const f = { deps: { dataSource: source }, verifyJwt: async () => { throw new Error('private token detail') } }
  await withAccountApp(f, async (base) => {
    const response = await fetch(`${base}/me`, { headers: { authorization: 'Bearer invalid' } })
    await expectAccountError(response, 401, 'AUTHENTICATION_REQUIRED')
  })
  assert.equal(databaseCalls, 0)
})

test('PATCH real stream transport rejection precedes JWT; JWT precedes field validation', async () => {
  let verifications = 0
  let databaseCalls = 0
  const source = { transaction: async () => {
    databaseCalls++
    throw new Error('unexpected DB')
  } }
  const f = { deps: { dataSource: source }, verifyJwt: async () => {
    verifications++
    throw new Error('private JWT')
  } }
  const transport = [
    [{ 'content-type': 'text/plain' }, [Buffer.alloc(17_000)], 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ 'content-type': 'application/json', 'content-encoding': 'gzip' }, ['{}'], 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ 'content-type': 'application/json;charset=latin1' }, ['{}'], 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ 'content-type': 'application/json' }, [Buffer.alloc(8_000), Buffer.alloc(8_385)], 413, 'REQUEST_TOO_LARGE'],
    [{ 'content-type': 'application/json' }, [Buffer.alloc(16_384, 'x')], 400, 'INVALID_AUTH_REQUEST'],
    [{ 'content-type': 'application/json' }, [Buffer.from([0xff])], 400, 'INVALID_AUTH_REQUEST'],
    [{ 'content-type': 'application/json' }, [], 400, 'INVALID_AUTH_REQUEST'],
    [{ 'content-type': 'application/json' }, ['{'], 400, 'INVALID_AUTH_REQUEST'],
  ]
  await withAccountApp(f, async (base) => {
    for (const [headers, chunks, status, code] of transport) {
      const response = await rawAccountRequest(base, {
        headers: { ...headers, authorization: 'Bearer invalid' }, chunks,
      })
      assert.equal(response.status, status)
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(JSON.parse(response.body).error.code, code)
      assert.equal(verifications, 0)
    }
    for (const input of [null, [], {}, { nickname: 1 }, { nickname: '\ud800' }, { nickname: 'ok', userId: 'untrusted' }]) {
      const response = await fetch(`${base}/me/nickname`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer invalid' },
        body: JSON.stringify(input),
      })
      await expectAccountError(response, 401, 'AUTHENTICATION_REQUIRED')
    }
  })
  assert.equal(verifications, 6)
  assert.equal(databaseCalls, 0)
})
