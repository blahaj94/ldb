import { beforeEach, expect, it, vi } from 'vitest'
import type { AuthSnapshot } from '../../../preload/common/types/auth'
import type { SearchCommandResult, SearchSnapshot } from '../../../preload/common/types/search'
import { SEARCH_RUN, searchSnapshot } from '../../../preload/api/search-test-fixture'

const connectionState = vi.hoisted(() => ({
  responses: [] as Array<SearchCommandResult | null | Promise<SearchCommandResult | null>>
}))

vi.mock('./connection', () => ({
  SearchConnection: class {
    readonly ready = true

    connect(): void {
      return undefined
    }

    command(): Promise<SearchCommandResult | null> {
      const response = connectionState.responses.shift()
      return Promise.resolve(response ?? null)
    }

    dispose(): void {
      return undefined
    }

    invoke(send: () => Promise<SearchCommandResult>): Promise<SearchCommandResult | null> {
      return send()
    }
  }
}))

const { CaptureSearch } = await import('./capture-search')

const auth: AuthSnapshot = {
  runId: SEARCH_RUN,
  revision: 1,
  phase: 'signedIn',
  providers: [],
  login: null,
  user: { nickname: '합성 계정' },
  entry: 'home',
  notice: null
}

type MutableCaptureSearch = {
  capture: {
    active: boolean
    captureId: string | null
    revisions: number[]
    cleared: boolean[]
  } | null
  snapshot: SearchSnapshot | null
}

function observedSnapshot(prefix: string, events: string[]): SearchSnapshot {
  const snapshot = searchSnapshot()
  return {
    get runId() {
      events.push(`${prefix}.runId`)
      return snapshot.runId
    },
    get revision() {
      events.push(`${prefix}.revision`)
      return snapshot.revision
    },
    get captureId() {
      events.push(`${prefix}.captureId`)
      return snapshot.captureId
    },
    slots: snapshot.slots
  }
}

function createSearch(): InstanceType<typeof CaptureSearch> {
  return new CaptureSearch({
    api: {
      controlCharacterSearch: vi.fn(),
      onCharacterSearchChanged: vi.fn(() => () => {})
    },
    notify: vi.fn(),
    onChange: vi.fn(),
    onInvalidated: vi.fn(),
    resynchronizeAuth: vi.fn()
  })
}

beforeEach(() => {
  connectionState.responses = []
})

it('begin은 양쪽 snapshot 비교 뒤 signal을 정확히 한 번 읽는다', async () => {
  const events: string[] = []
  const latest = observedSnapshot('latest', events)
  const completed = observedSnapshot('completed', events)
  const signal = {
    get aborted() {
      events.push('signal.aborted')
      return false
    }
  } as AbortSignal
  const search = createSearch()
  ;(search as unknown as MutableCaptureSearch).snapshot = latest
  const response = Promise.withResolvers<SearchCommandResult | null>()
  connectionState.responses.push(response.promise)

  const begin = search.begin({ auth, signal })
  const ticket = (search as unknown as MutableCaptureSearch).capture!
  let activeReadCount = 0
  Object.defineProperty(ticket, 'active', {
    get: () => {
      activeReadCount += 1
      const isInspectionRead = activeReadCount === 1
      events.push(isInspectionRead ? 'current.active.inspection' : 'current.active.publish')
      return true
    }
  })
  response.resolve({ ok: true, snapshot: completed })
  await begin

  expect(events).toEqual([
    'completed.captureId',
    'current.active.inspection',
    'latest.runId',
    'completed.runId',
    'latest.revision',
    'completed.revision',
    'latest.captureId',
    'signal.aborted',
    'current.active.publish',
    'latest.captureId'
  ])
  expect(activeReadCount).toBe(2)
})

it('begin은 completed가 없으면 latest captureId 뒤 signal만 읽는다', async () => {
  const events: string[] = []
  const latest = observedSnapshot('latest', events)
  const signal = {
    get aborted() {
      events.push('signal.aborted')
      return false
    }
  } as AbortSignal
  const search = createSearch()
  ;(search as unknown as MutableCaptureSearch).snapshot = latest
  connectionState.responses.push(null)

  await search.begin({ auth, signal })

  expect(events).toEqual(['latest.captureId', 'signal.aborted'])
})

it('begin은 latest와 completed가 모두 없으면 snapshot getter 없이 signal만 읽는다', async () => {
  const events: string[] = []
  const signal = {
    get aborted() {
      events.push('signal.aborted')
      return false
    }
  } as AbortSignal
  const search = createSearch()
  connectionState.responses.push(null)

  await search.begin({ auth, signal })

  expect(events).toEqual(['signal.aborted'])
})

it('늦은 begin은 stale ticket의 active getter를 읽지 않는다', async () => {
  const events: string[] = []
  const completed = observedSnapshot('completed', events)
  const response = Promise.withResolvers<SearchCommandResult | null>()
  const search = createSearch()
  connectionState.responses.push(response.promise)

  const begin = search.begin({ auth, signal: new AbortController().signal })
  const mutableSearch = search as unknown as MutableCaptureSearch
  const staleTicket = mutableSearch.capture!
  Object.defineProperty(staleTicket, 'active', {
    get: () => {
      events.push('stale.active')
      return true
    }
  })
  mutableSearch.capture = {
    active: true,
    captureId: null,
    revisions: [0, 0, 0, 0],
    cleared: [true, true, true, true]
  }

  response.resolve({ ok: true, snapshot: completed })
  await begin

  expect(events).toEqual(['completed.captureId'])
})
