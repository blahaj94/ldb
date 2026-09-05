/* global fetch */
import assert from 'node:assert/strict'
import process from 'node:process'
import { createLoginHttpApp } from '../dist/auth/login/http.js'
import { opaque } from './login-fixtures.mjs'

const stdout = process.stdout.write, stderr = process.stderr.write
const captured = []
const capture = (chunk, encoding, callback) => {
  captured.push(String(chunk))
  if (typeof encoding === 'function') encoding()
  else if (typeof callback === 'function') callback()
  return true
}
let app, failed = false
process.stdout.write = capture
process.stderr.write = capture
try {
  const fail = () => { throw new Error('credential-canary provider-subject nickname SQL secret') }
  app = await createLoginHttpApp({ create: fail, authorize: fail, exchange: fail, callback: fail })
  await app.listen(0, '127.0.0.1')
  const base = await app.getUrl()
  const callback = await fetch(`${base}/auth/callback/google?state=${opaque()}&code=credential-canary`, {
    headers: { cookie: 'credential-canary', authorization: 'Bearer credential-canary' }, redirect: 'manual',
  })
  assert.equal(callback.status, 500)
  assert.doesNotMatch(await callback.text(), /credential-canary|provider-subject|nickname|SQL|secret/)
  const malformed = await fetch(`${base}/auth/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"credential-canary":',
  })
  assert.equal(malformed.status, 400)
  assert.doesNotMatch(await malformed.text(), /credential-canary/)
} catch { failed = true } finally {
  try { await app?.close() } catch { failed = true }
  process.stdout.write = stdout
  process.stderr.write = stderr
}
if (failed || captured.length) {
  process.stderr.write('Login log probe failed\n')
  process.exitCode = 1
} else process.stdout.write('Login log probe passed\n')
