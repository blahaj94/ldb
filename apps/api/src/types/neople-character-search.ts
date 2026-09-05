export interface NeopleCharacterSearchInput {
  characterName: string
  serverId: string
  limit: number
}

export interface CharacterCandidate {
  characterId: string
  characterName: string
  serverId: string
  serverName: string | null
  fame: number | null
}

export interface CharacterSearchResult {
  rows: CharacterCandidate[]
}

export interface SearchErrorBody {
  error: {
    code: string
    message: string
  }
}

export type FetchTransport = (request: string | URL, init?: RequestInit) => Promise<Response>
export type SearchCharacters = (input: NeopleCharacterSearchInput) => Promise<CharacterSearchResult>

export interface SearchDependencies {
  fetch: FetchTransport
  origin: string
  now: () => number
  setTimer: (callback: () => void, delay: number) => unknown
  clearTimer: (timer: unknown) => void
}

export interface NeopleCharacterSearchTestDependencies {
  fetch: FetchTransport
  origin?: string
  now?: () => number
  setTimer?: SearchDependencies['setTimer']
  clearTimer?: SearchDependencies['clearTimer']
}
