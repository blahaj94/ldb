import type {
  SearchCommandResult,
  SearchControl,
  SearchObservation,
  SearchSlot,
  SearchSnapshot
} from '../common/types/search'

export const CAPTURE_ID = '00000000-0000-4000-8000-000000000011'
export const REQUEST_ID = '00000000-0000-4000-8000-000000000012'
export const SEARCH_RUN = '00000000-0000-4000-8000-000000000013'
export const searchRow = {
  characterId: 'synthetic-character',
  characterName: '<b>가나</b>',
  serverId: 'cain',
  serverName: '카인',
  fame: 0
}

export type SearchTestApi = {
  controlCharacterSearch: (control: SearchControl) => Promise<SearchCommandResult>
  onCharacterSearchChanged: (listener: (snapshot: SearchSnapshot) => void) => () => void
}
export type ObservationTestApi = {
  notifyStableNicknameDetected: (observation: SearchObservation) => Promise<SearchCommandResult>
}

export function searchSlot(overrides: Partial<SearchSlot> = {}): SearchSlot {
  return {
    slot: 0,
    observationRevision: 1,
    requestId: REQUEST_ID,
    nickname: '가나',
    state: 'pending',
    rows: [],
    error: null,
    ...overrides
  }
}

export function searchSnapshot(overrides: Partial<SearchSnapshot> = {}): SearchSnapshot {
  return {
    runId: SEARCH_RUN,
    revision: 1,
    captureId: CAPTURE_ID,
    slots: Array.from({ length: 4 }, (_, slot) => ({
      slot,
      observationRevision: 0,
      requestId: null,
      nickname: null,
      state: 'idle' as const,
      rows: [],
      error: null
    })),
    ...overrides
  }
}

export function withSearchSlot(slot: SearchSlot): SearchSnapshot {
  const snapshot = searchSnapshot()
  return {
    ...snapshot,
    slots: snapshot.slots.map((current) => {
      const isTarget = current.slot === slot.slot
      return isTarget ? slot : current
    })
  }
}

export const invalidSearchSnapshots: Array<[string, () => unknown]> = [
  ['unknown top-level field', () => ({ ...searchSnapshot(), token: 'synthetic-forbidden' })],
  ['non-UUID capture', () => searchSnapshot({ captureId: 'arbitrary-capture' })],
  ['negative revision', () => searchSnapshot({ revision: -1 })],
  ['unsafe revision', () => searchSnapshot({ revision: Number.MAX_SAFE_INTEGER + 1 })],
  ['three slots', () => searchSnapshot({ slots: searchSnapshot().slots.slice(0, 3) })],
  ['duplicate slot', () => searchSnapshot({ slots: Array(4).fill(searchSnapshot().slots[0]) })],
  ['reverse slot order', () => searchSnapshot({ slots: [...searchSnapshot().slots].reverse() })],
  [
    'unknown slot field',
    () => withSearchSlot({ ...searchSlot(), token: 'synthetic' } as SearchSlot)
  ],
  ['idle request', () => withSearchSlot(searchSlot({ state: 'idle' }))],
  ['pending rows', () => withSearchSlot(searchSlot({ rows: [searchRow] }))],
  [
    'pending error',
    () => withSearchSlot(searchSlot({ error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: null } }))
  ],
  ['zero active observation', () => withSearchSlot(searchSlot({ observationRevision: 0 }))],
  ['missing active nickname', () => withSearchSlot(searchSlot({ nickname: null }))],
  ['missing active request', () => withSearchSlot(searchSlot({ requestId: null }))],
  ['non-UUID request', () => withSearchSlot(searchSlot({ requestId: 'arbitrary-request' }))],
  ['success without rows', () => withSearchSlot(searchSlot({ state: 'success' }))],
  ['empty with rows', () => withSearchSlot(searchSlot({ state: 'empty', rows: [searchRow] }))],
  ['failure without error', () => withSearchSlot(searchSlot({ state: 'failure' }))],
  [
    'failure with rows',
    () =>
      withSearchSlot(
        searchSlot({
          state: 'failure',
          rows: [searchRow],
          error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: null }
        })
      )
  ],
  [
    'unknown row field',
    () =>
      withSearchSlot(
        searchSlot({
          state: 'success',
          rows: [{ ...searchRow, private: true } as typeof searchRow]
        })
      )
  ],
  [
    'invalid row fame',
    () => withSearchSlot(searchSlot({ state: 'success', rows: [{ ...searchRow, fame: Infinity }] }))
  ],
  [
    'retry time on timeout',
    () =>
      withSearchSlot(
        searchSlot({ state: 'failure', error: { code: 'SEARCH_TIMEOUT', retryAfterSeconds: 2 } })
      )
  ],
  [
    'negative retry time',
    () =>
      withSearchSlot(
        searchSlot({
          state: 'failure',
          error: { code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: -1 }
        })
      )
  ],
  [
    'unknown error field',
    () =>
      withSearchSlot(
        searchSlot({
          state: 'failure',
          error: {
            code: 'SEARCH_TIMEOUT',
            retryAfterSeconds: null,
            message: 'private'
          } as SearchSlot['error']
        })
      )
  ],
  ['ended capture with active slot', () => ({ ...withSearchSlot(searchSlot()), captureId: null })]
]
