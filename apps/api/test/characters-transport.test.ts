import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createNeopleCharacterSearchForTest } from '../src/characters/neople-character-search.js'
import { NeopleSearchFailure } from '../src/errors/neople-search.js'

interface Loopback {
  origin: string
  server: Server
}

async function startLoopback(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<Loopback> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const hasAddress = Boolean(address)
  assert(hasAddress)
  const isAddressObject = typeof address !== 'string'
  assert(isAddressObject)
  return { origin: `http://127.0.0.1:${(address as { port: number }).port}`, server }
}

async function closeLoopback(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      const hasError = error != null
      if (hasError) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

async function expectStatus(
  promise: Promise<unknown>,
  status: number
): Promise<NeopleSearchFailure> {
  try {
    await promise
  } catch (error) {
    const isSearchFailure = error instanceof NeopleSearchFailure
    assert(isSearchFailure)
    assert.equal(error.status, status)
    return error
  }
  assert.fail('expected search to fail')
}

test('native fetch safely encodes the fixed endpoint and sends one header-authenticated GET', async () => {
  const requests: IncomingMessage[] = []
  const loopback = await startLoopback((request, response) => {
    requests.push(request)
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        rows: [{ characterId: 'id', characterName: '가 나+&/?', serverId: 'cain', fame: 0 }]
      })
    )
  })

  try {
    const search = createNeopleCharacterSearchForTest('obvious-placeholder-key', {
      fetch,
      origin: loopback.origin
    })
    const result = await search({ characterName: '가 나+&/?', serverId: 'cain', limit: 200 })

    assert.equal(result.rows[0]?.characterName, '가 나+&/?')
    assert.equal(requests.length, 1)
    const request = requests[0]
    const hasRequestUrl = Boolean(request?.url)
    assert(hasRequestUrl)
    const validatedRequest = request as IncomingMessage
    const url = new URL(validatedRequest.url as string, loopback.origin)
    assert.equal(url.pathname, '/df/servers/cain/characters')
    assert.equal(url.searchParams.get('characterName'), '가 나+&/?')
    assert.equal(url.searchParams.get('limit'), '200')
    assert.equal(url.searchParams.get('wordType'), 'full')
    assert.equal(url.searchParams.size, 3)
    assert.equal(validatedRequest.method, 'GET')
    assert.equal(validatedRequest.headers.apikey, 'obvious-placeholder-key')
    assert.equal((validatedRequest.url as string).includes('obvious-placeholder-key'), false)
  } finally {
    await closeLoopback(loopback.server)
  }
})

test('native fetch does not follow redirects or retry upstream failures', async () => {
  let requests = 0
  const loopback = await startLoopback((_request, response) => {
    requests += 1
    const isFirstRequest = requests === 1
    if (isFirstRequest) {
      response.writeHead(302, { location: '/followed' })
      response.end()
      return
    }
    response.end(JSON.stringify({ rows: [] }))
  })

  try {
    const search = createNeopleCharacterSearchForTest('obvious-placeholder-key', {
      fetch,
      origin: loopback.origin
    })
    const error = await expectStatus(
      search({ characterName: '리다이렉트', serverId: 'cain', limit: 10 }),
      502
    )
    assert.equal(error.body.error.code, 'NEOPLE_API_ERROR')
    assert.equal(requests, 1)
  } finally {
    await closeLoopback(loopback.server)
  }
})

test('malformed loopback JSON keeps the upstream 503 fallback', async () => {
  let requests = 0
  const loopback = await startLoopback((_request, response) => {
    requests += 1
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end('not-json')
  })

  try {
    const search = createNeopleCharacterSearchForTest('obvious-placeholder-key', {
      fetch,
      origin: loopback.origin
    })
    const error = await expectStatus(
      search({ characterName: '점검중', serverId: 'all', limit: 1 }),
      503
    )
    assert.deepEqual(error.body, {
      error: {
        code: 'NEOPLE_UNAVAILABLE',
        message: '현재 캐릭터 검색을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'
      }
    })
    assert.equal(requests, 1)
  } finally {
    await closeLoopback(loopback.server)
  }
})

test('loopback API901 overrides HTTP 503 with the known-code 502 mapping', async () => {
  let requests = 0
  const loopback = await startLoopback((_request, response) => {
    requests += 1
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'API901', status: 503 } }))
  })

  try {
    const search = createNeopleCharacterSearchForTest('obvious-placeholder-key', {
      fetch,
      origin: loopback.origin
    })
    const error = await expectStatus(
      search({ characterName: '코드우선', serverId: 'cain', limit: 10 }),
      502
    )
    assert.deepEqual(error.body, {
      error: {
        code: 'NEOPLE_API_ERROR',
        message: '캐릭터 검색 중 오류가 발생했습니다.'
      }
    })
    assert.equal(requests, 1)
  } finally {
    await closeLoopback(loopback.server)
  }
})

test('deadline aborts native fetch while the loopback body is still incomplete', async () => {
  let now = 0
  const captured: { signal?: AbortSignal } = {}
  let deadlineCallback: (() => void) | undefined
  let scheduledDelay: number | undefined
  let requests = 0
  let markResponseClosed: (() => void) | undefined
  const responseClosed = new Promise<void>((resolve) => {
    markResponseClosed = resolve
  })
  const loopback = await startLoopback((_request, response) => {
    requests += 1
    response.once('close', () => markResponseClosed?.())
    response.writeHead(200, { 'content-type': 'application/json' })
    response.flushHeaders()
    response.write('{"rows":[')
  })

  try {
    const search = createNeopleCharacterSearchForTest('obvious-placeholder-key', {
      fetch: async (request, init) => {
        const isSignalNotNull = init?.signal !== null
        if (isSignalNotNull) {
          const isSignalDefined = init?.signal !== undefined
          if (isSignalDefined) {
            captured.signal = init.signal as AbortSignal
          }
        }
        const response = await fetch(request, init)
        return {
          status: response.status,
          ok: response.ok,
          text: async () => {
            const body = response.text()
            now = 5_000
            const hasDeadlineCallback = Boolean(deadlineCallback)
            assert(hasDeadlineCallback)
            deadlineCallback!()
            return body
          }
        } as Response
      },
      origin: loopback.origin,
      now: () => now,
      setTimer: (callback, timeout) => {
        deadlineCallback = callback
        scheduledDelay = timeout
        return Symbol('timer')
      },
      clearTimer: () => undefined
    })

    const error = await expectStatus(
      search({ characterName: '본문지연', serverId: 'cain', limit: 10 }),
      504
    )
    assert.equal(error.body.error.code, 'NEOPLE_TIMEOUT')
    assert.equal(captured.signal?.aborted, true)
    assert.equal(scheduledDelay, 5_000)
    assert.equal(requests, 1)
    await Promise.race([
      responseClosed,
      delay(1_000).then(() => assert.fail('upstream response was not closed after abort'))
    ])
  } finally {
    await closeLoopback(loopback.server)
  }
})

test('clock deadline aborts an unfinished native body before its timer callback fires', async () => {
  let now = 0
  const captured: { signal?: AbortSignal } = {}
  let scheduledDelay: number | undefined
  let timerCleared = false
  let requests = 0
  let markResponseClosed: (() => void) | undefined
  const responseClosed = new Promise<void>((resolve) => {
    markResponseClosed = resolve
  })
  const loopback = await startLoopback((_request, response) => {
    requests += 1
    response.once('close', () => markResponseClosed?.())
    response.writeHead(200, { 'content-type': 'application/json' })
    response.flushHeaders()
    response.write('{"rows":[')
  })

  try {
    const search = createNeopleCharacterSearchForTest('obvious-placeholder-key', {
      fetch: async (request, init) => {
        const isSignalNotNull = init?.signal !== null
        if (isSignalNotNull) {
          const isSignalDefined = init?.signal !== undefined
          if (isSignalDefined) {
            captured.signal = init.signal as AbortSignal
          }
        }
        const response = await fetch(request, init)
        now = 5_000
        return response
      },
      origin: loopback.origin,
      now: () => now,
      setTimer: (_callback, timeout) => {
        scheduledDelay = timeout
        return Symbol('timer')
      },
      clearTimer: () => {
        timerCleared = true
      }
    })

    const error = await expectStatus(
      search({ characterName: '헤더지연', serverId: 'cain', limit: 10 }),
      504
    )
    assert.equal(error.body.error.code, 'NEOPLE_TIMEOUT')
    assert.equal(captured.signal?.aborted, true)
    assert.equal(scheduledDelay, 5_000)
    assert.equal(timerCleared, true)
    assert.equal(requests, 1)
    await Promise.race([
      responseClosed,
      delay(1_000).then(() => assert.fail('upstream response was not closed after clock timeout'))
    ])
  } finally {
    await closeLoopback(loopback.server)
  }
})
