import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { loginJsonParser } from '../dist/auth/login/json-parser.js'
import { LOGIN_ERRORS } from '../dist/constants/login.js'
import { LoginFailure } from '../dist/errors/login.js'

function parserFixture() {
  const request = new PassThrough({ autoDestroy: false })
  Object.assign(request, {
    method: 'POST',
    path: '/auth/exchange',
    rawHeaders: ['Content-Type', 'application/json']
  })
  const responses = []
  const nextCalls = []
  const headers = {}
  const response = {
    headersSent: false,
    destroyed: false,
    setHeader: (name, value) => {
      headers[name] = value
    },
    status: (status) => ({
      json: (body) => responses.push({ status, body })
    })
  }
  loginJsonParser(request, response, (error) => nextCalls.push(error))
  return { request, response, responses, nextCalls, headers }
}

function assertInvalidResponse(responses) {
  assert.deepEqual(responses, [
    {
      status: 400,
      body: {
        error: {
          code: LOGIN_ERRORS.INVALID_REQUEST.code,
          message: LOGIN_ERRORS.INVALID_REQUEST.message
        }
      }
    }
  ])
}

test('split UTF-8 is decoded only after collection; truncated UTF-8 and BOM stay invalid', async () => {
  const body = Buffer.from('{"code":"한"}')
  const split = Buffer.byteLength('{"code":"') + 1
  const valid = parserFixture()
  valid.request.write(body.subarray(0, split))
  assert.deepEqual(valid.nextCalls, [])
  valid.request.end(body.subarray(split))
  await setImmediate()
  assert.deepEqual(valid.request.body, { code: '한' })
  assert.deepEqual(valid.nextCalls, [undefined])
  assert.deepEqual(valid.responses, [])
  valid.request.destroy()

  for (const bytes of [
    body.subarray(0, split),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
  ]) {
    const invalid = parserFixture()
    invalid.request.end(bytes)
    await setImmediate()
    assert.equal(invalid.nextCalls.length, 1)
    assert.ok(invalid.nextCalls[0] instanceof LoginFailure)
    assert.equal(invalid.nextCalls[0].code, LOGIN_ERRORS.INVALID_REQUEST.code)
    assert.equal(invalid.nextCalls[0].message, LOGIN_ERRORS.INVALID_REQUEST.message)
    assert.equal(invalid.request.body, undefined)
    assert.deepEqual(invalid.responses, [])
    invalid.request.destroy()
  }
})

test('request errors stay sanitized 400 even when their metadata resembles raw-body errors', async () => {
  for (const type of [undefined, 'entity.too.large', 'request.aborted']) {
    const f = parserFixture()
    f.request.write('{"code":"fixture-credential')
    f.request.emit(
      'error',
      Object.assign(new Error('fixture-private-detail'), { type, status: 413 })
    )
    await setImmediate()
    assertInvalidResponse(f.responses)
    assert.deepEqual(f.nextCalls, [])
    assert.equal(f.request.body, undefined)
    assert.equal(f.request.listenerCount('data'), 0)
    assert.equal(f.request.listenerCount('end'), 0)
    f.request.destroy()
  }
})

test('request errors do not respond after headers or response destruction', async () => {
  for (const state of ['headersSent', 'destroyed']) {
    const f = parserFixture()
    f.response[state] = true
    f.request.emit('error', new Error('fixture-private-detail'))
    await setImmediate()
    assert.deepEqual(f.responses, [])
    assert.deepEqual(f.nextCalls, [])
    f.request.destroy()
  }
})

test('abort followed by a request error never responds or advances middleware', async () => {
  const f = parserFixture()
  f.request.write('{"code":"fixture-credential')
  f.request.emit('aborted')
  f.request.emit('error', new Error('fixture-private-detail'))
  await setImmediate()
  assert.deepEqual(f.responses, [])
  assert.deepEqual(f.nextCalls, [])
  assert.equal(f.request.body, undefined)
  assert.equal(f.request.listenerCount('data'), 0)
  assert.equal(f.request.listenerCount('end'), 0)
  f.request.destroy()
})

test('overflow responds before end and a later request error cannot replace the 413', async () => {
  const f = parserFixture()
  f.request.write(Buffer.alloc(8192, 'x'))
  f.request.write(Buffer.alloc(8193, 'x'))
  assert.equal(f.responses.length, 1)
  assert.equal(f.responses[0].status, 413)
  assert.equal(f.responses[0].body.error.code, LOGIN_ERRORS.TOO_LARGE.code)
  assert.equal(f.headers.Connection, 'close')
  assert.equal(f.request.isPaused(), true)
  f.request.emit('error', new Error('fixture-private-detail'))
  await setImmediate()
  assert.equal(f.responses.length, 1)
  assert.deepEqual(f.nextCalls, [])
  assert.equal(f.request.body, undefined)
  f.request.destroy()
})

test('terminal paths release collection listeners and close releases the late-error guard', async () => {
  for (const outcome of ['success', 'invalid', 'overflow', 'error', 'aborted']) {
    const f = parserFixture()
    switch (outcome) {
      case 'success':
        f.request.end('{}')
        break
      case 'invalid':
        f.request.end('{')
        break
      case 'overflow':
        f.request.write(Buffer.alloc(16385))
        break
      case 'error':
        f.request.emit('error', new Error('fixture-private-detail'))
        break
      case 'aborted':
        f.request.emit('aborted')
        break
    }
    await setImmediate()
    for (const event of ['data', 'end', 'aborted']) {
      assert.equal(f.request.listenerCount(event), 0, `${outcome}: ${event}`)
    }
    f.request.destroy()
    await setImmediate()
    assert.equal(f.request.listenerCount('error'), 0, outcome)
    assert.equal(f.request.listenerCount('close'), 0, outcome)
  }
})
