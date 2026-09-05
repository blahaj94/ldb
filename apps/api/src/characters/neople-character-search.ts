import { NEOPLE_SERVER_NAMES } from './servers.js'

const NEOPLE_ORIGIN = 'https://api.neople.co.kr'
const DEADLINE_MS = 5_000

const errors = {
  internal: {
    status: 500,
    code: 'INTERNAL_SERVER_ERROR',
    message: '서버 오류로 검색을 처리하지 못했습니다.',
  },
  api: {
    status: 502,
    code: 'NEOPLE_API_ERROR',
    message: '캐릭터 검색 중 오류가 발생했습니다.',
  },
  unavailable: {
    status: 503,
    code: 'NEOPLE_UNAVAILABLE',
    message: '현재 캐릭터 검색을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.',
  },
  timeout: {
    status: 504,
    code: 'NEOPLE_TIMEOUT',
    message: '캐릭터 검색 응답 시간이 초과됐습니다. 다시 시도해 주세요.',
  },
} as const

const upstreamCodeErrors = new Map<string, keyof typeof errors>([
  ['API000', 'internal'],
  ['API003', 'internal'],
  ['API004', 'internal'],
  ['API005', 'internal'],
  ['API002', 'unavailable'],
  ['API008', 'unavailable'],
  ['DNF980', 'unavailable'],
  ['API901', 'api'],
  ['DNF901', 'api'],
  ['DNF000', 'api'],
  ['API006', 'api'],
  ['API007', 'api'],
  ['API900', 'api'],
  ['API999', 'api'],
  ['DNF999', 'api'],
])

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

export class NeopleSearchFailure extends Error {
  readonly body: SearchErrorBody

  constructor(
    readonly status: number,
    code: string,
    message: string,
  ) {
    super(message)
    this.name = 'NeopleSearchFailure'
    this.body = { error: { code, message } }
  }
}

type FetchTransport = (request: string | URL, init?: RequestInit) => Promise<Response>
type SearchCharacters = (input: NeopleCharacterSearchInput) => Promise<CharacterSearchResult>

interface SearchDependencies {
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

const nativeDependencies: SearchDependencies = {
  fetch: (request, init) => fetch(request, init),
  origin: NEOPLE_ORIGIN,
  now: () => performance.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

function failure(kind: keyof typeof errors): NeopleSearchFailure {
  const error = errors[kind]
  return new NeopleSearchFailure(error.status, error.code, error.message)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function statusFailure(status: number): NeopleSearchFailure {
  return failure(status === 429 || status === 503 ? 'unavailable' : 'api')
}

function projectResponse(body: unknown, status: number, ok: boolean): CharacterSearchResult {
  if (isObject(body) && Object.hasOwn(body, 'error')) {
    const upstreamError = body.error
    const code = isObject(upstreamError) && typeof upstreamError.code === 'string'
      ? upstreamError.code
      : undefined
    const knownError = code === undefined ? undefined : upstreamCodeErrors.get(code)
    throw knownError === undefined ? statusFailure(status) : failure(knownError)
  }

  if (!ok || !isObject(body) || !Array.isArray(body.rows)) {
    throw statusFailure(status)
  }

  const rows = body.rows.map((candidate): CharacterCandidate => {
    if (!isObject(candidate)) throw failure('api')

    const { characterId, characterName, serverId } = candidate
    if (
      typeof characterId !== 'string' ||
      characterId.trim() === '' ||
      typeof characterName !== 'string' ||
      characterName.trim() === '' ||
      typeof serverId !== 'string' ||
      serverId.trim() === ''
    ) {
      throw failure('api')
    }

    const rawFame = candidate.fame
    if (rawFame !== undefined && rawFame !== null &&
      (typeof rawFame !== 'number' || !Number.isFinite(rawFame))) {
      throw failure('api')
    }

    return {
      characterId,
      characterName,
      serverId,
      serverName: NEOPLE_SERVER_NAMES.get(serverId) ?? null,
      fame: rawFame ?? null,
    }
  })

  return { rows }
}

function buildUrl(input: NeopleCharacterSearchInput, origin: string): URL {
  const url = new URL(
    `/df/servers/${encodeURIComponent(input.serverId)}/characters`,
    origin,
  )
  url.searchParams.set('characterName', input.characterName)
  url.searchParams.set('limit', String(input.limit))
  url.searchParams.set('wordType', 'full')
  return url
}

function makeSearch(apiKey: string, dependencies: SearchDependencies): SearchCharacters {
  return async (input) => {
    const url = buildUrl(input, dependencies.origin)
    const controller = new AbortController()
    const startedAt = dependencies.now()
    const deadline = startedAt + DEADLINE_MS
    let didTimeout = false
    let rejectTimeout: (reason: NeopleSearchFailure) => void = () => undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject
    })
    const timer = dependencies.setTimer(() => {
      didTimeout = true
      controller.abort()
      rejectTimeout(failure('timeout'))
    }, DEADLINE_MS)
    const deadlineReached = (): boolean => {
      if (!didTimeout && dependencies.now() < deadline) return false
      didTimeout = true
      controller.abort()
      return true
    }

    const request = async (): Promise<CharacterSearchResult> => {
      let response: Response
      try {
        response = await dependencies.fetch(url, {
          method: 'GET',
          headers: { apikey: apiKey },
          redirect: 'manual',
          signal: controller.signal,
        })
      } catch {
        throw deadlineReached() ? failure('timeout') : failure('api')
      }

      if (deadlineReached()) throw failure('timeout')

      let rawBody: string
      try {
        rawBody = await response.text()
      } catch {
        throw deadlineReached() ? failure('timeout') : failure('api')
      }

      if (deadlineReached()) throw failure('timeout')

      let body: unknown
      try {
        body = JSON.parse(rawBody) as unknown
      } catch {
        throw deadlineReached() ? failure('timeout') : statusFailure(response.status)
      }

      try {
        const result = projectResponse(body, response.status, response.ok)
        if (deadlineReached()) throw failure('timeout')
        return result
      } catch (error) {
        if (deadlineReached()) throw failure('timeout')
        throw error instanceof NeopleSearchFailure ? error : failure('api')
      }
    }

    try {
      return await Promise.race([request(), timeout])
    } finally {
      dependencies.clearTimer(timer)
    }
  }
}

export function createNeopleCharacterSearch(apiKey: string): SearchCharacters {
  return makeSearch(apiKey, nativeDependencies)
}

export function createNeopleCharacterSearchForTest(
  apiKey: string,
  overrides: NeopleCharacterSearchTestDependencies,
): SearchCharacters {
  return makeSearch(apiKey, { ...nativeDependencies, ...overrides })
}
