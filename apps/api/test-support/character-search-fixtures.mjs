/* global fetch */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { URL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createSearchQueryRunner } from '../dist/characters/search-query-runner.js'
import { createLoginHttpApp, createSessionHttpService } from '../dist/auth/login/http.js'
import { createNeopleCharacterSearchForTest } from '../dist/characters/neople-character-search.js'
import { accountFixture, snapshot } from './account-http-fixtures.mjs'

export { accountFixture as searchFixture, snapshot }

const unusedLogin = Object.fromEntries(
  ['create', 'authorize', 'callback', 'exchange'].map((name) => [
    name,
    async () => {
      throw new Error('unrelated login route called')
    }
  ])
)

export async function isolatedNeople() {
  const calls = []
  const sockets = new Set()
  const upstream = {
    status: 200,
    body: { rows: [] },
    respond: undefined,
    start: undefined,
    failure: undefined
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://loopback.invalid')
    calls.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      hasExpectedKey: request.headers.apikey === 'synthetic-search-key'
    })
    const hasCustomResponse = upstream.respond != null
    if (hasCustomResponse) {
      void Promise.resolve(upstream.respond(request, response)).catch((error) => {
        upstream.failure = error
        response.destroy()
      })
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
  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    upstream,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise((resolve, reject) =>
        server.close((error) => {
          const hasError = error != null
          if (hasError) {
            reject(error)
          } else {
            resolve()
          }
        })
      )
    }
  }
}

export async function withSearchApp(f, operation, overrides = {}) {
  const neople = await isolatedNeople()
  const { calls, upstream } = neople
  const adapter = createNeopleCharacterSearchForTest('synthetic-search-key', {
    fetch,
    origin: neople.origin
  })
  const searchCharacters = (input) => {
    upstream.start?.()
    return adapter(input)
  }
  const deps = {
    dataSource: f.deps.dataSource,
    verifyAccessJwt: f.verifyJwt,
    apiKey: 'synthetic-search-key',
    searchCharacters,
    ...overrides
  }
  const app = await createLoginHttpApp(
    unusedLogin,
    createSessionHttpService(f.deps),
    undefined,
    deps
  )
  try {
    await app.listen(0, '127.0.0.1')
    const result = await operation({ base: await app.getUrl(), calls, upstream, deps, app })
    assert.equal(upstream.failure, undefined)
    return result
  } finally {
    await app.close()
    await neople.close()
  }
}

export function searchRequest(base, f, query = 'characterName=ab', options = {}) {
  return fetch(`${base}/characters?${query}`, {
    headers: { authorization: `Bearer ${f.token.accessToken}` },
    ...options
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

export function observeSearchRunners(hooks = {}) {
  return (source, signal) => {
    const runner = createSearchQueryRunner(source, signal)
    const query = runner.query.bind(runner)
    const commit = runner.commitTransaction.bind(runner)
    const release = runner.release.bind(runner)
    runner.query = (sql, parameters, ...rest) => {
      const run = () => query(sql, parameters, ...rest)
      const hasHook = hooks.query != null
      return hasHook ? hooks.query({ runner, sql, parameters, query, run }) : run()
    }
    runner.commitTransaction = () => {
      const hasHook = hooks.commit != null
      return hasHook ? hooks.commit(runner, commit) : commit()
    }
    runner.release = async () => {
      await release()
      hooks.released?.(runner)
    }
    hooks.created?.(runner, signal)
    return runner
  }
}

export function barrier() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

export async function waitFor(check, message = 'search observation did not arrive') {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const ready = await check()
    if (ready) {
      return
    }
    await delay(10)
  }
  assert.fail(message)
}

export async function assertBackendGone(source, pid) {
  await waitFor(async () => {
    const [row] = await source.query(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid=$1',
      [pid]
    )
    return row.count === 0
  }, 'search backend remained after cancellation')
}
