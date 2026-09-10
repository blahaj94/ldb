import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuthHttpClient, AuthHttpFailure } from './http'
import type { AuthTokens } from './types'
import {
  ACCESS_1,
  API_ORIGIN,
  CODE,
  REFRESH_0,
  REFRESH_1,
  REQUEST_ID,
  USER_ID
} from './auth-test-fixtures'

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' }

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: jsonHeaders })
}

type RecordedRequest = Pick<
  Request,
  'url' | 'method' | 'redirect' | 'cache' | 'credentials' | 'signal'
> &
  Readonly<{ headers: Record<string, string>; body: unknown }>

async function inspectRequest(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<RecordedRequest> {
  const request = new Request(input, init)
  const hasBody = request.body != null
  const body: unknown = hasBody ? await request.json() : null
  return {
    url: request.url,
    method: request.method,
    redirect: request.redirect,
    cache: request.cache,
    credentials: request.credentials,
    headers: Object.fromEntries(request.headers),
    signal: request.signal,
    body
  }
}

function validTokens(): AuthTokens {
  return {
    tokenType: 'Bearer',
    accessToken: ACCESS_1,
    accessTokenExpiresAt: '2026-09-06T12:15:00.000Z',
    refreshToken: REFRESH_1,
    sessionExpiresAt: '2026-10-06T12:00:00.000Z'
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Desktop auth 고정 HTTP client', () => {
  it('login request를 고정 endpoint와 exact JSON body로 한 번 전송한다', async () => {
    const ticket = Buffer.alloc(32, 8).toString('base64url')
    const requests: RecordedRequest[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(await inspectRequest(input, init))
      return jsonResponse(
        {
          requestId: REQUEST_ID,
          browserUrl: `${API_ORIGIN}/auth/login/authorize?ticket=${ticket}`,
          expiresAt: '2026-09-06T12:10:00.000Z'
        },
        201
      )
    })
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

    await expect(
      client.createLoginRequest(
        {
          provider: 'google',
          clientId: 'desktop',
          codeChallenge: Buffer.alloc(32, 4).toString('base64url'),
          codeChallengeMethod: 'S256'
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ requestId: REQUEST_ID })

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(requests[0]).toMatchObject({
      url: `${API_ORIGIN}/auth/login-requests`,
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit'
    })
    expect(requests[0].body).toEqual({
      provider: 'google',
      clientId: 'desktop',
      codeChallenge: Buffer.alloc(32, 4).toString('base64url'),
      codeChallengeMethod: 'S256'
    })
  })

  it('exchange, refresh, GET /me와 logout에 caller URL 없이 고정 schema를 사용한다', async () => {
    const responses = [
      jsonResponse({
        ...validTokens(),
        user: { id: USER_ID, nickname: '모험가000001' },
        isNewUser: false
      }),
      jsonResponse(validTokens()),
      jsonResponse({ user: { id: USER_ID, nickname: '모험가000001' } }),
      new Response(null, { status: 204 })
    ]
    const requests: RecordedRequest[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requests.push(await inspectRequest(input, init))
      return responses.shift()!
    })
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })
    const signal = new AbortController().signal

    await client.exchange(
      { requestId: REQUEST_ID, clientId: 'desktop', code: CODE, codeVerifier: CODE },
      signal
    )
    await client.refresh(REFRESH_0, signal)
    await client.me(ACCESS_1, signal)
    await client.logout(REFRESH_1, signal)

    expect(requests.map((request) => request.url)).toEqual([
      `${API_ORIGIN}/auth/exchange`,
      `${API_ORIGIN}/auth/refresh`,
      `${API_ORIGIN}/me`,
      `${API_ORIGIN}/auth/logout`
    ])
    expect(requests[0].body).toEqual({
      requestId: REQUEST_ID,
      clientId: 'desktop',
      code: CODE,
      codeVerifier: CODE
    })
    expect(requests[1].body).toEqual({
      refreshToken: REFRESH_0
    })
    expect(requests[1]).toMatchObject({
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      signal: expect.any(AbortSignal)
    })
    expect(requests[2].headers).toMatchObject({ authorization: `Bearer ${ACCESS_1}` })
    expect(requests[3].body).toEqual({
      refreshToken: REFRESH_1
    })
    expect(requests[3]).toMatchObject({
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      signal: expect.any(AbortSignal)
    })
  })

  it('oversize, malformed, unknown field와 credential 형태를 성공으로 해석하지 않는다', async () => {
    const responses = [
      new Response('x'.repeat(16_385), { status: 200, headers: jsonHeaders }),
      new Response('{', { status: 200, headers: jsonHeaders }),
      jsonResponse({ ...validTokens(), extra: true }),
      jsonResponse({ ...validTokens(), refreshToken: `${REFRESH_1}=` }),
      new Response(JSON.stringify(validTokens()), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=iso-8859-1' }
      })
    ]
    const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!)
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

    for (let index = 0; index < 5; index += 1) {
      await expect(client.refresh(REFRESH_0, new AbortController().signal)).rejects.toMatchObject({
        code: 'invalid-response'
      })
    }
  })

  it('정해진 오류 body만 분류하고 raw body나 외부 Error를 노출하지 않는다', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'LOGIN_EXCHANGE_INVALID',
              message: '로그인 요청이 유효하지 않습니다. 다시 로그인해 주세요.'
            }
          },
          400
        )
      )
      .mockRejectedValueOnce(new Error(`transport ${REFRESH_0}`))
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })
    const signal = new AbortController().signal

    await expect(
      client.exchange(
        { requestId: REQUEST_ID, clientId: 'desktop', code: CODE, codeVerifier: CODE },
        signal
      )
    ).rejects.toMatchObject({ code: 'exchange-invalid' })

    const failure = await client.refresh(REFRESH_0, signal).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AuthHttpFailure)
    expect(JSON.stringify(failure)).not.toContain(REFRESH_0)
    expect(String(failure)).not.toContain('transport')
  })

  it('header부터 response body까지 하나의 15초 deadline으로 취소한다', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init)
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

    const refresh = client.refresh(REFRESH_0, new AbortController().signal)
    const rejected = expect(refresh).rejects.toMatchObject({
      code: 'network',
      transmission: 'unknown'
    })
    await vi.advanceTimersByTimeAsync(15_000)

    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('이미 취소된 caller는 fetch를 시작하지 않는다', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })
    const controller = new AbortController()
    controller.abort()

    await expect(client.refresh(REFRESH_0, controller.signal)).rejects.toMatchObject({
      code: 'network',
      transmission: 'not-sent'
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('oversize Content-Length를 거절할 때 response stream도 취소한다', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ cancel })
    const response = new Response(stream, {
      status: 200,
      headers: {
        ...jsonHeaders,
        'Content-Length': '16385'
      }
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response)
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

    await expect(client.refresh(REFRESH_0, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid-response'
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each(['Infinity', 'not-a-number', '-1'])(
    '유한하지 않거나 음수인 Content-Length 선언은 body 평가를 보정하지 않는다: %s',
    async (contentLength) => {
      const response = new Response(JSON.stringify(validTokens()), {
        status: 200,
        headers: { ...jsonHeaders, 'Content-Length': contentLength }
      })
      const fetch = vi.fn<typeof globalThis.fetch>(async () => response)
      const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

      await expect(client.refresh(REFRESH_0, new AbortController().signal)).resolves.toEqual(
        validTokens()
      )
    }
  )

  it('response header 뒤 body가 멈춰도 같은 deadline에 stream을 취소한다', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel
    })
    const response = new Response(stream, { status: 200, headers: jsonHeaders })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response)
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

    const refresh = client.refresh(REFRESH_0, new AbortController().signal)
    const rejected = expect(refresh).rejects.toMatchObject({ code: 'network' })
    await vi.advanceTimersByTimeAsync(15_000)

    await rejected
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each([
    { tokenType: 'bearer' },
    { accessToken: 'a.b.é' },
    { accessToken: `a.b.${'c'.repeat(8189)}` },
    { accessTokenExpiresAt: '2026-02-30T12:00:00Z' },
    { accessTokenExpiresAt: '2026-09-06T12:00:00.1234Z' },
    { sessionExpiresAt: '2026-09-06T12:00:00+00:00' },
    { sessionExpiresAt: '2026-02-30T12:00:00Z' },
    { refreshToken: `${REFRESH_1.slice(0, -1)}x` }
  ])('token field 경계 %j를 보정 없이 거절한다', async (override) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ ...validTokens(), ...override })
    )
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

    await expect(client.refresh(REFRESH_0, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid-response'
    })
  })

  it('Date.parse가 non-finite면 toISOString 없이 정확히 invalid-response를 반환한다', async () => {
    const parse = vi.spyOn(Date, 'parse').mockReturnValue(Number.NaN)
    const toISOString = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => {
      throw new Error('toISOString must be skipped')
    })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(validTokens()))
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

    try {
      await expect(client.refresh(REFRESH_0, new AbortController().signal)).rejects.toMatchObject({
        code: 'invalid-response'
      })
      expect(parse).toHaveBeenCalled()
      expect(toISOString).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
      toISOString.mockRestore()
    }
  })

  it.each(['', '.1', '.12', '.123'])(
    '기존 UTC 소수초 %s와 ASCII access 상한을 그대로 허용한다',
    async (fraction) => {
      const tokens = {
        ...validTokens(),
        accessToken: `a.b.${'c'.repeat(8188)}`,
        accessTokenExpiresAt: `2026-09-06T12:00:00${fraction}Z`
      }
      const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(tokens))
      const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

      await expect(client.refresh(REFRESH_0, new AbortController().signal)).resolves.toEqual(tokens)
    }
  )

  it.each(['', '  é👩‍👩‍👧‍👦  '])(
    'UUID shape와 well-formed nickname %j를 normalize하거나 추가 제한하지 않는다',
    async (nickname) => {
      const value = { user: { id: 'ABCDEFAB-0000-0000-0000-ABCDEFABCDEF', nickname } }
      const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(value))
      const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

      await expect(client.me(ACCESS_1, new AbortController().signal)).resolves.toEqual(value)
    }
  )

  it.each([
    { user: { id: USER_ID, nickname: '\ud800' } },
    { user: { id: USER_ID, nickname: '\udc00' } },
    { user: { id: USER_ID, nickname: 1 } },
    { user: { id: USER_ID, nickname: 'name', [REFRESH_0]: true } },
    { user: { id: USER_ID, nickname: 'name' }, [REFRESH_0]: true }
  ])('user shape와 불신 field를 정제 오류로 거절한다: %j', async (value) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(value))
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

    const error = await client.me(ACCESS_1, new AbortController().signal).catch((value) => value)
    expect(error).toBeInstanceOf(AuthHttpFailure)
    expect(error.code).toBe('invalid-response')
    expect(JSON.stringify(error)).not.toContain(REFRESH_0)
    expect(String(error)).not.toContain(REFRESH_0)
  })

  it('strict UTF-8와 Unicode 응답 byte 상한은 JSON/schema 검사 전에 적용한다', async () => {
    const responses = [
      new Response(new Uint8Array([0xc3, 0x28]), { headers: jsonHeaders }),
      jsonResponse({ user: { id: USER_ID, nickname: '가'.repeat(5500) } }),
      jsonResponse({ error: { code: 'AUTH_UNAVAILABLE', message: '가'.repeat(5500) } }, 503)
    ]
    const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!)
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

    for (let index = 0; index < 3; index += 1) {
      await expect(client.me(ACCESS_1, new AbortController().signal)).rejects.toMatchObject({
        code: 'invalid-response'
      })
    }
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('정제 error의 nested unknown key를 거절하고 GET 503을 자동 retry하지 않는다', async () => {
    const responses = [
      jsonResponse(
        {
          error: {
            code: 'AUTH_UNAVAILABLE',
            message: '현재 계정 기능을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'
          }
        },
        503
      ),
      jsonResponse(
        {
          error: {
            code: 'AUTH_UNAVAILABLE',
            message: '현재 계정 기능을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
            [REFRESH_0]: true
          }
        },
        503
      )
    ]
    const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!)
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })

    await expect(client.me(ACCESS_1, new AbortController().signal)).rejects.toMatchObject({
      code: 'unavailable'
    })
    const error = await client.me(ACCESS_1, new AbortController().signal).catch((value) => value)
    expect(error).toBeInstanceOf(AuthHttpFailure)
    expect(error.code).toBe('invalid-response')
    expect(JSON.stringify(error)).not.toContain(REFRESH_0)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('14.9초에 header를 받아도 body의 남은 deadline은 0.1초다', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(new ReadableStream({ cancel }), { headers: jsonHeaders })),
            14_900
          )
        })
    )
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })
    const refresh = client.refresh(REFRESH_0, new AbortController().signal)
    const rejected = expect(refresh).rejects.toMatchObject({ code: 'network' })

    await vi.advanceTimersByTimeAsync(14_900)
    expect(cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('body를 읽는 중 caller abort도 stream을 취소하고 network 실패로 정제한다', async () => {
    const cancel = vi.fn()
    const pull = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(new ReadableStream({ pull, cancel }), { headers: jsonHeaders })
    )
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })
    const controller = new AbortController()
    const refresh = client.refresh(REFRESH_0, controller.signal)
    const rejected = expect(refresh).rejects.toMatchObject({ code: 'network' })

    await vi.waitFor(() => expect(pull).toHaveBeenCalled())
    controller.abort()
    await rejected
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
