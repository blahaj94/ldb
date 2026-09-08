export type SearchControl =
  | Readonly<{ action: 'read' }>
  | Readonly<{ action: 'begin'; authRunId: string; authRevision: number }>
  | Readonly<{ action: 'end'; captureId: string }>

export type SearchSlot = Readonly<{
  slot: number
  observationRevision: number
  requestId: null
  nickname: null
  state: 'idle'
  rows: readonly never[]
  error: null
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
