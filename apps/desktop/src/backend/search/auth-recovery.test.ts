import { describe, expect, it, vi } from 'vitest'
import type { AuthAuthorization } from '../auth/types'
import type { SearchErrorCode, SearchSlot } from '../../preload/common/types/search'
import { ACCESS_2, REFRESH_2, deferred, tokenResponse } from '../auth/auth-test-fixtures'
import { createSearchFixture, jsonResponse } from './search-test-fixture'

type Fixture = Awaited<ReturnType<typeof createSearchFixture>>

function unauthorized(): Response {
  return jsonResponse({
    status: 401,
    body: { error: { code: 'AUTHENTICATION_REQUIRED', message: 'discard' } }
  })
}

function tokensFor({
  fixture,
  seed,
  expiresInMs = 15 * 60_000
}: {
  fixture: Fixture
  seed: number
  expiresInMs?: number
}): ReturnType<typeof tokenResponse> {
  const bytes = Buffer.alloc(32, seed)
  const refreshToken = bytes.toString('base64url')
  const expiry = new Date(fixture.harness.clock.wallMs + expiresInMs).toISOString()
  return tokenResponse({
    refreshToken,
    accessToken: `stage${seed}.payload.signature`,
    accessTokenExpiresAt: expiry
  })
}

async function failure(fixture: Fixture, code: SearchErrorCode, slot = 0): Promise<SearchSlot> {
  await vi.waitFor(async () => expect((await fixture.read()).slots[slot].state).not.toBe('pending'))
  const result = (await fixture.read()).slots[slot]
  expect(result).toMatchObject({
    state: 'failure',
    rows: [],
    error: { code, retryAfterSeconds: null }
  })
  expect(result.requestId).toEqual(expect.any(String))
  return result
}

function retry(fixture: Fixture, slot: SearchSlot): Promise<unknown> {
  return fixture.invoke('controlCharacterSearch', {
    action: 'retry',
    captureId: fixture.captureId,
    slot: slot.slot,
    requestId: slot.requestId
  })
}

async function available(
  fixture: Fixture
): Promise<Extract<AuthAuthorization, { status: 'available' }>> {
  const authorization = await fixture.auth.authorization()
  expect(authorization).toMatchObject({ status: 'available' })
  return authorization as Extract<AuthAuthorization, { status: 'available' }>
}

async function flushSearch(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('검색 401 회복과 수동 재시도', () => {
  it('401 회복은 자동 GET 없이 끝나며 사용자 retry만 최신 access로 새 GET을 보낸다', async () => {
    const fixture = await createSearchFixture()
    fixture.fetchSearch.mockResolvedValueOnce(unauthorized())
    fixture.harness.http.refresh.mockResolvedValueOnce(
      tokenResponse({ refreshToken: REFRESH_2, accessToken: ACCESS_2 })
    )

    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    const failed = await failure(fixture, 'SEARCH_AUTH_RETRY_REQUIRED')

    expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)
    expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(1)
    expect(fixture.auth.getSnapshot().phase).toBe('signedIn')
    expect(await retry(fixture, failed)).toMatchObject({ ok: true })
    await vi.waitFor(async () => expect((await fixture.read()).slots[0].state).toBe('empty'))
    expect((await fixture.read()).slots[0].requestId).not.toBe(failed.requestId)
    expect(fixture.fetchSearch).toHaveBeenCalledTimes(2)
    const request = new Request(...fixture.fetchSearch.mock.calls[1])
    expect(request.headers.get('authorization')).toBe(`Bearer ${ACCESS_2}`)
  })

  it('revision 승격 뒤에도 회복된 실패의 retry가 최신 access에서 401이면 최종 인증 상실이다', async () => {
    const fixture = await createSearchFixture()
    fixture.fetchSearch.mockImplementation(async () => unauthorized())
    fixture.harness.http.refresh.mockResolvedValueOnce(
      tokenResponse({ refreshToken: REFRESH_2, accessToken: ACCESS_2 })
    )
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    const failed = await failure(fixture, 'SEARCH_AUTH_RETRY_REQUIRED')
    await fixture.observe({ slot: 0, observationRevision: 2, nickname: '가나' })

    expect(await retry(fixture, failed)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(fixture.auth.getSnapshot().phase).toBe('signedOut'))

    expect(fixture.auth.getSnapshot().notice).toBe('REAUTH_REQUIRED')
    const snapshot = await fixture.read()
    expect(snapshot.captureId).toBeNull()
    expect(snapshot.slots.map((slot) => slot.state)).toEqual(['idle', 'idle', 'idle', 'idle'])
    expect(fixture.fetchSearch).toHaveBeenCalledTimes(2)
    expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(1)
    expect(fixture.harness.http.logout).toHaveBeenCalledTimes(1)
  })

  it('다른 caller가 access를 교체한 뒤 도착한 401은 추가 refresh와 자동 GET이 없다', async () => {
    const fixture = await createSearchFixture()
    const used = await available(fixture)
    const response = deferred<Response>()
    fixture.fetchSearch.mockReturnValueOnce(response.promise)
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    await vi.waitFor(() => expect(fixture.fetchSearch).toHaveBeenCalledTimes(1))
    fixture.harness.http.refresh.mockResolvedValueOnce(
      tokenResponse({ refreshToken: REFRESH_2, accessToken: ACCESS_2 })
    )
    await fixture.auth.recoverAuthorization({
      generation: used.generation,
      accessGeneration: used.accessGeneration,
      finalRejection: false
    })

    response.resolve(unauthorized())
    await failure(fixture, 'SEARCH_AUTH_RETRY_REQUIRED')

    expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(1)
    expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)
    expect(fixture.harness.http.logout).not.toHaveBeenCalled()
  })

  it('동시 401의 한 slot 취소는 다른 slot·일반 caller의 공유 refresh를 중단하지 않는다', async () => {
    const fixture = await createSearchFixture()
    const first = deferred<Response>()
    const second = deferred<Response>()
    const refresh = deferred<ReturnType<typeof tokenResponse>>()
    fixture.fetchSearch.mockReturnValueOnce(first.promise)
    fixture.fetchSearch.mockReturnValueOnce(second.promise)
    fixture.harness.http.refresh.mockReturnValueOnce(refresh.promise)
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    await fixture.observe({ slot: 1, observationRevision: 1, nickname: '다라' })
    await vi.waitFor(() => expect(fixture.fetchSearch).toHaveBeenCalledTimes(2))
    first.resolve(unauthorized())
    second.resolve(unauthorized())
    let ordinary: Promise<AuthAuthorization> | undefined

    try {
      await vi.waitFor(() => expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(1))
      ordinary = fixture.auth.authorization()
      await fixture.invoke('controlCharacterSearch', {
        action: 'clear',
        captureId: fixture.captureId,
        slot: 0,
        observationRevision: 2
      })
      expect(fixture.harness.http.refresh.mock.calls[0][1].aborted).toBe(false)
    } finally {
      refresh.resolve(tokenResponse({ refreshToken: REFRESH_2, accessToken: ACCESS_2 }))
      await ordinary
    }

    await failure(fixture, 'SEARCH_AUTH_RETRY_REQUIRED', 1)
    expect((await fixture.read()).slots[0].state).toBe('idle')
    expect(await ordinary).toMatchObject({ status: 'available', accessToken: ACCESS_2 })
    expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(1)
    expect(fixture.fetchSearch).toHaveBeenCalledTimes(2)
  })

  it('401 회복 대기도 첫 GET의 남은 예산만 사용하고 늦은 refresh 뒤 GET을 보내지 않는다', async () => {
    const fixture = await createSearchFixture()
    const response = deferred<Response>()
    const refresh = deferred<ReturnType<typeof tokenResponse>>()
    fixture.fetchSearch.mockReturnValueOnce(response.promise)
    fixture.harness.http.refresh.mockReturnValueOnce(refresh.promise)
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    await vi.waitFor(() => expect(fixture.fetchSearch).toHaveBeenCalledTimes(1))
    fixture.harness.clock.advance(10_000)
    response.resolve(unauthorized())

    try {
      await vi.waitFor(() => expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(1))
      fixture.harness.clock.advance(5_000)
      await flushSearch()
      await failure(fixture, 'SEARCH_TIMEOUT')
      expect(fixture.harness.http.refresh.mock.calls[0][1].aborted).toBe(false)
    } finally {
      refresh.resolve(tokenResponse({ refreshToken: REFRESH_2, accessToken: ACCESS_2 }))
      await fixture.auth.authorization()
      await flushSearch()
    }

    expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)
    await failure(fixture, 'SEARCH_TIMEOUT')
  })

  it('새 nickname은 이전 회복된 실패의 최종 401 이력을 승계하지 않는다', async () => {
    const fixture = await createSearchFixture()
    fixture.fetchSearch.mockImplementation(async () => unauthorized())
    fixture.harness.http.refresh.mockResolvedValueOnce(tokensFor({ fixture, seed: 14 }))
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    await failure(fixture, 'SEARCH_AUTH_RETRY_REQUIRED')
    fixture.harness.http.refresh.mockResolvedValueOnce(tokensFor({ fixture, seed: 15 }))

    await fixture.observe({ slot: 0, observationRevision: 2, nickname: '다라' })
    await failure(fixture, 'SEARCH_AUTH_RETRY_REQUIRED')

    expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(2)
    expect(fixture.fetchSearch).toHaveBeenCalledTimes(2)
    expect(fixture.harness.http.logout).not.toHaveBeenCalled()
  })
})

describe('인증을 보존한 authorization unavailable', () => {
  it.each(['before-get', '401-recovery'])(
    '%s에서 저장 중 만료는 NotReady로 종료하고 retry의 첫 401은 일반 회복이다',
    async (stage) => {
      const fixture = await createSearchFixture()
      const isBeforeGet = stage === 'before-get'
      if (isBeforeGet) {
        fixture.harness.clock.advance(16 * 60_000)
      } else {
        fixture.fetchSearch.mockResolvedValueOnce(unauthorized())
      }
      const tokens = tokensFor({ fixture, seed: 14, expiresInMs: 1_000 })
      const commit = deferred<'confirmed'>()
      fixture.harness.http.refresh.mockResolvedValueOnce(tokens)
      fixture.harness.store.commitCredential.mockClear()
      fixture.harness.store.commitWaits.push(commit.promise)
      const retryAuth = vi.spyOn(fixture.auth, 'retryAuth')
      await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })

      try {
        await vi.waitFor(() =>
          expect(fixture.harness.store.commitCredential).toHaveBeenCalledTimes(1)
        )
        fixture.harness.clock.advance(1_000)
      } finally {
        commit.resolve('confirmed')
        await flushSearch()
      }
      const failed = await failure(fixture, 'SEARCH_AUTH_NOT_READY')
      const previousGets = isBeforeGet ? 0 : 1
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(previousGets)
      expect(fixture.auth.getSnapshot().phase).toBe('signedIn')
      expect(fixture.harness.store.inspection).toEqual({
        status: 'ready',
        refreshToken: tokens.refreshToken
      })
      expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(1)
      expect(fixture.harness.http.logout).not.toHaveBeenCalled()
      expect(fixture.harness.store.clearCredential).not.toHaveBeenCalled()
      expect(retryAuth).not.toHaveBeenCalled()

      fixture.harness.http.refresh.mockResolvedValueOnce(tokensFor({ fixture, seed: 15 }))
      fixture.harness.http.refresh.mockResolvedValueOnce(tokensFor({ fixture, seed: 16 }))
      fixture.fetchSearch.mockResolvedValueOnce(unauthorized())
      expect(await retry(fixture, failed)).toMatchObject({ ok: true })
      const retried = await failure(fixture, 'SEARCH_AUTH_RETRY_REQUIRED')

      expect(retried.requestId).not.toBe(failed.requestId)
      expect(fixture.fetchSearch).toHaveBeenCalledTimes(previousGets + 1)
      expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(3)
      expect(fixture.harness.http.logout).not.toHaveBeenCalled()
      expect(retryAuth).not.toHaveBeenCalled()
    }
  )

  it('NotReady의 연속 retry도 매번 확정한 credential과 signedIn을 유지한다', async () => {
    const fixture = await createSearchFixture()
    fixture.harness.clock.advance(16 * 60_000)
    const first = tokensFor({ fixture, seed: 14, expiresInMs: 0 })
    fixture.harness.http.refresh.mockResolvedValueOnce(first)
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    const failed = await failure(fixture, 'SEARCH_AUTH_NOT_READY')
    const second = tokensFor({ fixture, seed: 15, expiresInMs: 0 })
    fixture.harness.http.refresh.mockResolvedValueOnce(second)

    expect(await retry(fixture, failed)).toMatchObject({ ok: true })
    const retried = await failure(fixture, 'SEARCH_AUTH_NOT_READY')

    expect(retried.requestId).not.toBe(failed.requestId)
    expect(fixture.harness.store.inspection).toEqual({
      status: 'ready',
      refreshToken: second.refreshToken
    })
    expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(2)
    expect(fixture.fetchSearch).not.toHaveBeenCalled()
    expect(fixture.harness.http.logout).not.toHaveBeenCalled()
    expect(fixture.auth.getSnapshot().phase).toBe('signedIn')
  })

  it('최종 401용 retry가 전송 전 NotReady로 끝나면 다음 retry에 그 이력을 넘기지 않는다', async () => {
    const fixture = await createSearchFixture()
    fixture.fetchSearch.mockImplementation(async () => unauthorized())
    fixture.harness.http.refresh.mockResolvedValueOnce(tokensFor({ fixture, seed: 14 }))
    await fixture.observe({ slot: 0, observationRevision: 1, nickname: '가나' })
    const recovered = await failure(fixture, 'SEARCH_AUTH_RETRY_REQUIRED')
    fixture.harness.clock.advance(16 * 60_000)
    fixture.harness.http.refresh.mockResolvedValueOnce(
      tokensFor({ fixture, seed: 15, expiresInMs: 0 })
    )
    expect(await retry(fixture, recovered)).toMatchObject({ ok: true })
    const notReady = await failure(fixture, 'SEARCH_AUTH_NOT_READY')
    expect(fixture.fetchSearch).toHaveBeenCalledTimes(1)
    fixture.harness.http.refresh.mockResolvedValueOnce(tokensFor({ fixture, seed: 16 }))
    fixture.harness.http.refresh.mockResolvedValueOnce(tokensFor({ fixture, seed: 17 }))

    expect(await retry(fixture, notReady)).toMatchObject({ ok: true })
    await failure(fixture, 'SEARCH_AUTH_RETRY_REQUIRED')

    expect(fixture.fetchSearch).toHaveBeenCalledTimes(2)
    expect(fixture.harness.http.refresh).toHaveBeenCalledTimes(4)
    expect(fixture.harness.http.logout).not.toHaveBeenCalled()
    expect(fixture.auth.getSnapshot().phase).toBe('signedIn')
  })
})
