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
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(
        {
          requestId: REQUEST_ID,
          browserUrl: `${API_ORIGIN}/auth/login/authorize?ticket=${ticket}`,
          expiresAt: '2026-09-06T12:10:00.000Z'
        },
        201
      )
    )
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
    const [url, request] = fetch.mock.calls[0]
    expect(url).toBe(`${API_ORIGIN}/auth/login-requests`)
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit'
    })
    expect(JSON.parse(String(request?.body))).toEqual({
      provider: 'google',
      clientId: 'desktop',
      codeChallenge: Buffer.alloc(32, 4).toString('base64url'),
      codeChallengeMethod: 'S256'
    })
  })

  it('exchange, refresh, GET /me와 logout에 caller URL 없이 고정 schema를 사용한다', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          ...validTokens(),
          user: { id: USER_ID, nickname: '모험가000001' },
          isNewUser: false
        })
      )
      .mockResolvedValueOnce(jsonResponse(validTokens()))
      .mockResolvedValueOnce(jsonResponse({ user: { id: USER_ID, nickname: '모험가000001' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const client = createAuthHttpClient({ apiOrigin: API_ORIGIN, fetch })
    const signal = new AbortController().signal

    await client.exchange(
      { requestId: REQUEST_ID, clientId: 'desktop', code: CODE, codeVerifier: CODE },
      signal
    )
    await client.refresh(REFRESH_0, signal)
    await client.me(ACCESS_1, signal)
    await client.logout(REFRESH_1, signal)

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${API_ORIGIN}/auth/exchange`,
      `${API_ORIGIN}/auth/refresh`,
      `${API_ORIGIN}/me`,
      `${API_ORIGIN}/auth/logout`
    ])
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      requestId: REQUEST_ID,
      clientId: 'desktop',
      code: CODE,
      codeVerifier: CODE
    })
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({
      refreshToken: REFRESH_0
    })
    expect(fetch.mock.calls[1][1]).toMatchObject({
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      signal: expect.any(AbortSignal)
    })
    expect(fetch.mock.calls[2][1]?.headers).toMatchObject({ Authorization: `Bearer ${ACCESS_1}` })
    expect(JSON.parse(String(fetch.mock.calls[3][1]?.body))).toEqual({
      refreshToken: REFRESH_1
    })
    expect(fetch.mock.calls[3][1]).toMatchObject({
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
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
    const fetch = vi.fn<typeof globalThis.fetch>((_url, request) => {
      return new Promise<Response>((_resolve, reject) => {
        request?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
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
})
