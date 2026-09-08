import type { AuthClock } from '../../src/backend/auth/types'

export const searchScenarios = {
  success: '검색 응답: 성공',
  empty: '검색 응답: 0건',
  failure: '검색 응답: 서버 오류',
  'rate-limit': '검색 응답: 5초 제한',
  pending: '검색 응답: 시간 초과 대기'
} as const
export type SearchScenario = keyof typeof searchScenarios

type Runtime = { apiOrigin: string; clock: AuthClock; fetch: typeof fetch }
export function createFixtureSearch({
  apiOrigin,
  clock
}: {
  apiOrigin: string
  clock: AuthClock
}): {
  runtime: Runtime
  selectScenario: (scenario: SearchScenario) => void
  queueScenarios: (scenarios: readonly SearchScenario[]) => void
  counts: { requests: number; pendingAborts: number }
} {
  const isSyntheticOrigin = apiOrigin === 'https://api.example.test'
  if (!isSyntheticOrigin) {
    throw new Error('Search fixture requires its fixed synthetic origin')
  }
  let scenario: SearchScenario = 'success'
  let queued: SearchScenario[] = []
  const counts = { requests: 0, pendingAborts: 0 }
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    const url = new URL(request.url)
    const hasOrigin = url.origin === apiOrigin
    const hasPath = url.pathname === '/characters'
    const hasMethod = request.method === 'GET'
    const keys = [...url.searchParams.keys()]
    const hasExactQuery = keys.length === 1 && keys[0] === 'characterName'
    const hasSyntheticAuth =
      request.headers.get('authorization') === 'Bearer synthetic.payload.signature'
    const isAllowed = hasOrigin && hasPath && hasMethod && hasExactQuery && hasSyntheticAuth
    if (!isAllowed) {
      throw new Error('Search fixture request denied')
    }
    counts.requests += 1
    const currentScenario = queued.shift() ?? scenario
    const isPending = currentScenario === 'pending'
    if (isPending) {
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => {
            counts.pendingAborts += 1
            reject(new DOMException('Synthetic search cancelled', 'AbortError'))
          },
          { once: true }
        )
      })
    }
    const isRateLimited = currentScenario === 'rate-limit'
    const isFailure = currentScenario === 'failure'
    const isEmpty = currentScenario === 'empty'
    const status = isRateLimited ? 429 : isFailure ? 500 : 200
    const rows = isEmpty
      ? []
      : [
          {
            characterId: 'synthetic-character',
            characterName: 'ALICE',
            serverId: 'cain',
            serverName: '카인',
            fame: 12345
          }
        ]
    const body = isRateLimited
      ? { error: { code: 'SEARCH_RATE_LIMITED' } }
      : isFailure
        ? { error: { code: 'INTERNAL_SERVER_ERROR' } }
        : { rows }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (isRateLimited) {
      headers['Retry-After'] = '5'
    }
    return new Response(JSON.stringify(body), { status, headers })
  }
  return {
    runtime: { apiOrigin, clock, fetch: transport },
    counts,
    queueScenarios: (scenarios) => {
      queued = [...scenarios]
    },
    selectScenario: (next) => {
      scenario = next
      queued = []
    }
  }
}
