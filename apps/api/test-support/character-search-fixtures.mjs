/* global fetch */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { URL } from 'node:url'
import { createLoginHttpApp, createSessionHttpService } from '../dist/auth/login/http.js'
import { createNeopleCharacterSearchForTest } from '../dist/characters/neople-character-search.js'
import { accountFixture, snapshot } from './account-http-fixtures.mjs'

export { accountFixture as searchFixture, snapshot }

const unusedLogin = Object.fromEntries(['create', 'authorize', 'callback', 'exchange'].map((name) => [
  name, async () => { throw new Error('unrelated login route called') },
]))

export async function withSearchApp(f, operation, overrides = {}) {
  const calls = []
  const sockets = new Set()
  const upstream = { status: 200, body: { rows: [] }, respond: undefined }
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://loopback.invalid')
    calls.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      hasExpectedKey: request.headers.apikey === 'synthetic-search-key',
    })
    const hasCustomResponse = upstream.respond != null
    if (hasCustomResponse) {
      upstream.respond(request, response)
      return
    }
    response.writeHead(upstream.status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(upstream.body))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const searchCharacters = createNeopleCharacterSearchForTest('synthetic-search-key', {
    fetch, origin: `http://127.0.0.1:${port}`,
  })
  const deps = {
    dataSource: f.deps.dataSource, verifyAccessJwt: f.verifyJwt,
    apiKey: 'synthetic-search-key', searchCharacters, ...overrides,
  }
  const app = await createLoginHttpApp(unusedLogin, createSessionHttpService(f.deps), undefined, deps)
  try {
    await app.listen(0, '127.0.0.1')
    return await operation({ base: await app.getUrl(), calls, upstream, deps })
  } finally {
    await app.close()
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve, reject) => server.close((error) => {
      const hasError = error != null
      if (hasError) reject(error)
      else resolve()
    }))
  }
}

export function searchRequest(base, f, query = 'characterName=ab', options = {}) {
  return fetch(`${base}/characters?${query}`, {
    headers: { authorization: `Bearer ${f.token.accessToken}` }, ...options,
  })
}

export async function expectSearchError(response, status, code) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type'), /^application\/json/)
  const body = await response.json()
  assert.deepEqual(Object.keys(body), ['error'])
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message'])
  assert.equal(body.error.code, code)
  return body
}
