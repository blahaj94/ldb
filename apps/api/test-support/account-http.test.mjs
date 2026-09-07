/* global fetch */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createConnection } from 'node:net'
import { URL } from 'node:url'
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

function rawWire(base, wire) {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    let response = ''
    const socket = createConnection({ host: url.hostname, port: Number(url.port) })
    socket.setTimeout(3000, () => {
      socket.destroy()
      reject(new Error('raw account HTTP did not close'))
    })
    socket.once('connect', () => socket.write(wire))
    socket.on('data', (chunk) => { response += chunk.toString('utf8') })
    socket.once('error', reject)
    socket.once('close', () => resolve(response))
  })
}

test('PATCH overflow closes before stream end; Node framing rejection does not expose input', async () => {
  let verifications = 0
  const f = { deps: {}, verifyJwt: async () => {
    verifications++
    throw new Error('unexpected verifier')
  } }
  await withAccountApp(f, async (base) => {
    const headers = 'PATCH /me/nickname HTTP/1.1\r\nHost: test.invalid\r\nContent-Type: application/json\r\n'
    const overflow = await rawWire(base, headers + 'Transfer-Encoding: chunked\r\n\r\n' +
      '2000\r\n' + 'x'.repeat(8192) + '\r\n2001\r\n' + 'x'.repeat(8193) + '\r\n')
    assert.match(overflow, /^HTTP\/1\.1 413/)
    assert.match(overflow, /Cache-Control: no-store/i)
    assert.match(overflow, /Connection: close/i)
    assert.match(overflow, /REQUEST_TOO_LARGE/)

    const framing = await rawWire(base, headers +
      'Content-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\ncredential-canary')
    assert.match(framing, /^HTTP\/1\.1 400/)
    assert.doesNotMatch(framing, /credential-canary|Parse Error|stack/)
    assert.equal(verifications, 0)
  })
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
