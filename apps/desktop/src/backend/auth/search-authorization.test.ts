import { describe, expect, it, vi } from 'vitest'
import { createAuthCoordinator } from './coordinator'
import { AuthHttpFailure } from './http'
import type { AuthAuthorization, AuthCoordinator } from './types'
import {
  ACCESS_2,
  CODE,
  REFRESH_0,
  REFRESH_2,
  RETURN_TARGET,
  createAuthHarness,
  deferred,
  settle,
  tokenResponse
} from './auth-test-fixtures'

type AvailableAccess = Extract<AuthAuthorization, { status: 'available' }> & {
  accessGeneration: number
}
type RejectedAccess = Pick<AvailableAccess, 'generation' | 'accessGeneration'> & {
  finalRejection: boolean
}
// 새 소비 경계의 Red에서 기존 factory를 사용한다. 구현 뒤 제품 type으로 대체한다.
type SearchCoordinator = Omit<AuthCoordinator, 'authorization'> & {
  authorization(signal?: AbortSignal): Promise<AuthAuthorization>
  recoverAuthorization(input: RejectedAccess, signal?: AbortSignal): Promise<AuthAuthorization>
}

async function setup(): Promise<{
  auth: SearchCoordinator
  harness: ReturnType<typeof createAuthHarness>
}> {
  const harness = createAuthHarness()
  harness.store.inspection = { status: 'ready', refreshToken: REFRESH_0 }
  const auth = createAuthCoordinator(harness.dependencies) as SearchCoordinator
  await auth.start()
  harness.http.refresh.mockClear()
  harness.http.me.mockClear()
  harness.store.commitCredential.mockClear()
  harness.store.removeTransition.mockClear()
  return { auth, harness }
}

async function usedAccess(auth: SearchCoordinator): Promise<AvailableAccess> {
  const result = await auth.authorization()
  expect(result).toMatchObject({ status: 'available' })
  return result as AvailableAccess
}

function rejectAccess(
  auth: SearchCoordinator,
  access: AvailableAccess,
  finalRejection = false,
  signal?: AbortSignal
): Promise<AuthAuthorization> {
  expect(auth.recoverAuthorization, '검색 401은 main core의 회복 경계를 사용한다').toBeTypeOf(
    'function'
  )
  return auth.recoverAuthorization(
    { generation: access.generation, accessGeneration: access.accessGeneration, finalRejection },
    signal
  )
}

describe('검색의 main authorization 소비 경계', () => {
  it('access 교체는 auth 수명을 유지하며 구분 가능한 access generation을 제공한다', async () => {
    const { auth, harness } = await setup()
    const before = await usedAccess(auth)
    expect(before.accessGeneration).toEqual(expect.any(Number))
    harness.clock.advance(16 * 60_000)
    harness.http.refresh.mockResolvedValueOnce(
      tokenResponse(REFRESH_2, ACCESS_2, '2026-09-06T12:31:00.000Z')
    )

    const after = await usedAccess(auth)

    expect(after.generation).toBe(before.generation)
    expect(after.accessGeneration).toBeGreaterThan(before.accessGeneration)
    expect(harness.http.refresh).toHaveBeenCalledTimes(1)
  })

  it('이미 취소된 waiter는 현재 access가 있어도 unavailable이며 refresh를 시작하지 않는다', async () => {
    const { auth, harness } = await setup()
    const controller = new AbortController()
    controller.abort()

    expect(await auth.authorization(controller.signal)).toEqual({ status: 'unavailable' })
    expect(harness.http.refresh).not.toHaveBeenCalled()
    expect(auth.getSnapshot().phase).toBe('signedIn')
  })

  it.each(['refresh', 'commit', 'finalize'])(
    '%s 중 waiter 취소는 즉시 종료하되 다른 caller와 credential 저장을 완료시킨다',
    async (boundary) => {
      const { auth, harness } = await setup()
      harness.clock.advance(16 * 60_000)
      const tokens = tokenResponse(REFRESH_2, ACCESS_2, '2026-09-06T12:31:00.000Z')
      const refresh = deferred<ReturnType<typeof tokenResponse>>()
      const storage = deferred<'confirmed'>()
      const isRefresh = boundary === 'refresh'
      const isCommit = boundary === 'commit'
      if (isRefresh) harness.http.refresh.mockReturnValueOnce(refresh.promise)
      else harness.http.refresh.mockResolvedValueOnce(tokens)
      if (isCommit) harness.store.commitWaits.push(storage.promise)
      const isFinalize = boundary === 'finalize'
      if (isFinalize) harness.store.removeWaits.push(storage.promise)
      const controller = new AbortController()
      let cancelledResult: AuthAuthorization | undefined
      const cancelled = auth.authorization(controller.signal).then((result) => {
        cancelledResult = result
        return result
      })
      const other = auth.authorization()
      const boundaryEffect = isRefresh
        ? harness.http.refresh
        : isCommit
          ? harness.store.commitCredential
          : harness.store.removeTransition

      try {
        await vi.waitFor(() => expect(boundaryEffect).toHaveBeenCalledTimes(1))
        controller.abort()
        await settle()

        expect(cancelledResult).toEqual({ status: 'unavailable' })
        expect(harness.http.refresh.mock.calls[0][1].aborted).toBe(false)
        expect(auth.getSnapshot().phase).toBe('signedIn')
      } finally {
        refresh.resolve(tokens)
        storage.resolve('confirmed')
        await Promise.all([cancelled, other])
      }

      expect(await other).toMatchObject({ status: 'available', accessToken: ACCESS_2 })
      expect(cancelledResult).toEqual({ status: 'unavailable' })
      expect(harness.store.inspection).toEqual({ status: 'ready', refreshToken: REFRESH_2 })
      expect(harness.http.refresh).toHaveBeenCalledTimes(1)
      expect(harness.http.logout).not.toHaveBeenCalled()
    }
  )

  it('현재 access의 동시 401은 기존 refresh 한 번과 저장 결과를 공유한다', async () => {
    const { auth, harness } = await setup()
    const access = await usedAccess(auth)
    const refresh = deferred<ReturnType<typeof tokenResponse>>()
    harness.http.refresh.mockReturnValueOnce(refresh.promise)

    const first = rejectAccess(auth, access)
    const second = rejectAccess(auth, access)
    await vi.waitFor(() => expect(harness.http.refresh).toHaveBeenCalledTimes(1))
    refresh.resolve(tokenResponse(REFRESH_2, ACCESS_2))
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult).toEqual(secondResult)
    expect(firstResult).toMatchObject({ status: 'available', accessToken: ACCESS_2 })
    expect(harness.store.commitCredential).toHaveBeenCalledTimes(1)
    expect(harness.http.me).not.toHaveBeenCalled()
    expect(auth.getSnapshot().phase).toBe('signedIn')
  })

  it('이미 교체된 access의 401은 추가 refresh 없이 최신 authorization을 반환한다', async () => {
    const { auth, harness } = await setup()
    const previous = await usedAccess(auth)
    harness.clock.advance(16 * 60_000)
    harness.http.refresh.mockResolvedValueOnce(
      tokenResponse(REFRESH_2, ACCESS_2, '2026-09-06T12:31:00.000Z')
    )
    const current = await usedAccess(auth)
    harness.http.refresh.mockClear()

    expect(await rejectAccess(auth, previous)).toEqual(current)
    expect(harness.http.refresh).not.toHaveBeenCalled()
    expect(harness.http.me).not.toHaveBeenCalled()
  })

  it('사용자 재시도의 최신 access 최종 401은 추가 refresh 없이 인증과 저장을 정리한다', async () => {
    const { auth, harness } = await setup()
    const access = await usedAccess(auth)

    expect(await rejectAccess(auth, access, true)).toEqual({ status: 'unavailable' })
    expect(auth.getSnapshot()).toMatchObject({ phase: 'signedOut', notice: 'REAUTH_REQUIRED' })
    expect(auth.captureGeneration()).toBeNull()
    expect(harness.store.inspection).toEqual({ status: 'empty' })
    expect(harness.http.refresh).not.toHaveBeenCalled()
    expect(harness.http.logout).toHaveBeenCalledTimes(1)
  })

  it('이전 로그인에서 사용한 access의 늦은 401은 재로그인 상태를 지우지 않는다', async () => {
    const { auth, harness } = await setup()
    const previous = await usedAccess(auth)
    await auth.logout()
    await auth.beginLogin('google')
    await vi.waitFor(() => expect(auth.getSnapshot().phase).toBe('waitingBrowser'))
    await auth.handleReturnUrl(`${RETURN_TARGET}?code=${CODE}`)
    const current = auth.getSnapshot()
    harness.http.logout.mockClear()

    expect(await rejectAccess(auth, previous, true)).toEqual({ status: 'unavailable' })
    expect(auth.getSnapshot()).toEqual(current)
    expect(harness.http.refresh).not.toHaveBeenCalled()
    expect(harness.http.logout).not.toHaveBeenCalled()
  })

  it('401 회복의 refresh 실패는 기존 인증 상실 cleanup을 수행한다', async () => {
    const { auth, harness } = await setup()
    const access = await usedAccess(auth)
    harness.http.refresh.mockRejectedValueOnce(new AuthHttpFailure('authentication-required'))

    expect(await rejectAccess(auth, access)).toEqual({ status: 'unavailable' })
    expect(auth.getSnapshot()).toMatchObject({ phase: 'signedOut', notice: 'REAUTH_REQUIRED' })
    expect(harness.store.inspection).toEqual({ status: 'empty' })
    expect(harness.http.refresh).toHaveBeenCalledTimes(1)
    expect(harness.http.me).not.toHaveBeenCalled()
  })
})
