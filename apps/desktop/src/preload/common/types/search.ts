export type SearchControl =
  | Readonly<{ action: 'read' }>
  | Readonly<{ action: 'begin'; authRunId: string; authRevision: number }>
  | Readonly<{ action: 'end'; captureId: string }>
  | Readonly<{ action: 'clear'; captureId: string; slot: number; observationRevision: number }>
  | Readonly<{ action: 'retry'; captureId: string; slot: number; requestId: string }>

export type SearchObservation = Readonly<{
  captureId: string
  slot: number
  observationRevision: number
  nickname: string
}>

export type CharacterSearchRow = Readonly<{
  characterId: string
  characterName: string
  serverId: string
  serverName: string | null
  fame: number | null
}>

export const SEARCH_ERRORS = {
  INVALID_SEARCH_QUERY: { message: '검색 조건을 확인해 주세요.', retryable: false },
  AUTHENTICATION_REQUIRED: { message: '로그인이 필요합니다.', retryable: false },
  SEARCH_RATE_LIMITED: {
    message: '검색 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
    retryable: true
  },
  INTERNAL_SERVER_ERROR: { message: '서버 오류로 검색을 처리하지 못했습니다.', retryable: true },
  NEOPLE_API_ERROR: { message: '캐릭터 검색 중 오류가 발생했습니다.', retryable: true },
  NEOPLE_UNAVAILABLE: {
    message: '현재 캐릭터 검색을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
    retryable: true
  },
  NEOPLE_TIMEOUT: {
    message: '캐릭터 검색 응답 시간이 초과됐습니다. 다시 시도해 주세요.',
    retryable: true
  },
  SEARCH_TIMEOUT: { message: '검색 시간이 초과됐습니다. 다시 시도해 주세요.', retryable: true },
  SEARCH_NETWORK_ERROR: {
    message: '검색 서버에 연결하지 못했습니다. 다시 시도해 주세요.',
    retryable: true
  },
  SEARCH_RESPONSE_INVALID: {
    message: '검색 응답을 확인하지 못했습니다. 다시 시도해 주세요.',
    retryable: true
  },
  SEARCH_AUTH_RETRY_REQUIRED: {
    message: '로그인 상태를 확인했습니다. 검색을 다시 시도해 주세요.',
    retryable: true
  },
  SEARCH_AUTH_NOT_READY: {
    message: '검색에 필요한 로그인 상태 확인을 마치지 못했습니다. 다시 시도해 주세요.',
    retryable: true
  }
} as const

export type SearchErrorCode = keyof typeof SEARCH_ERRORS
export type SearchError = Readonly<{ code: SearchErrorCode; retryAfterSeconds: number | null }>

export type SearchSlot = Readonly<{
  slot: number
  observationRevision: number
  requestId: string | null
  nickname: string | null
  state: 'idle' | 'pending' | 'success' | 'empty' | 'failure'
  rows: readonly CharacterSearchRow[]
  error: SearchError | null
}>

export type SearchSnapshot = Readonly<{
  runId: string
  revision: number
  captureId: string | null
  slots: readonly SearchSlot[]
}>

export type SearchCommandError =
  | 'INVALID_SEARCH_COMMAND'
  | 'SEARCH_NOT_ALLOWED'
  | 'STALE_SEARCH'
  | 'SEARCH_BUSY'
  | 'SEARCH_RETRY_NOT_READY'

export type SearchCommandResult =
  | Readonly<{ ok: true; snapshot: SearchSnapshot }>
  | Readonly<{ ok: false; error: { code: SearchCommandError }; snapshot: SearchSnapshot }>
