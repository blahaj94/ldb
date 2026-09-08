import {
  NEOPLE_ORIGIN,
  NEOPLE_SEARCH_DEADLINE_MS,
  NEOPLE_SERVER_NAMES
} from '../constants/neople-character-search.js'
import {
  classifyNeopleUpstreamFailure,
  neopleSearchFailure,
  neopleStatusFailure,
  NeopleSearchFailure
} from '../errors/neople-search.js'
import type {
  CharacterCandidate,
  CharacterSearchResult,
  NeopleCharacterSearchInput,
  NeopleCharacterSearchTestDependencies,
  SearchCharacters,
  SearchDependencies
} from '../types/neople-character-search.js'

const nativeDependencies: SearchDependencies = {
  fetch: (request, init) => fetch(request, init),
  origin: NEOPLE_ORIGIN,
  now: () => performance.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function projectResponse(body: unknown, status: number, ok: boolean): CharacterSearchResult {
  const upstreamFailure = classifyNeopleUpstreamFailure(body, status, ok)
  if (upstreamFailure !== undefined) {
    throw upstreamFailure
  }

  if (!isObject(body) || !Array.isArray(body.rows)) {
    throw neopleSearchFailure('api')
  }

  const rows = body.rows.map((candidate): CharacterCandidate => {
    if (!isObject(candidate)) {
      throw neopleSearchFailure('api')
    }

    const { characterId, characterName, serverId } = candidate
    if (
      typeof characterId !== 'string' ||
      characterId.trim() === '' ||
      typeof characterName !== 'string' ||
      characterName.trim() === '' ||
      typeof serverId !== 'string' ||
      serverId.trim() === ''
    ) {
      throw neopleSearchFailure('api')
    }

    const rawFame = candidate.fame
    if (
      rawFame !== undefined &&
      rawFame !== null &&
      (typeof rawFame !== 'number' || !Number.isFinite(rawFame))
    ) {
      throw neopleSearchFailure('api')
    }

    return {
      characterId,
      characterName,
      serverId,
      serverName: NEOPLE_SERVER_NAMES.get(serverId) ?? null,
      fame: rawFame ?? null
    }
  })

  return { rows }
}

function buildUrl(input: NeopleCharacterSearchInput, origin: string): URL {
  const url = new URL(`/df/servers/${encodeURIComponent(input.serverId)}/characters`, origin)
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
    const deadline = startedAt + NEOPLE_SEARCH_DEADLINE_MS
    let didTimeout = false
    let rejectTimeout: (reason: NeopleSearchFailure) => void = () => undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject
    })
    const timer = dependencies.setTimer(() => {
      didTimeout = true
      controller.abort()
      rejectTimeout(neopleSearchFailure('timeout'))
    }, NEOPLE_SEARCH_DEADLINE_MS)
    const deadlineReached = (): boolean => {
      if (!didTimeout && dependencies.now() < deadline) {
        return false
      }
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
          signal: controller.signal
        })
      } catch {
        throw deadlineReached() ? neopleSearchFailure('timeout') : neopleSearchFailure('api')
      }

      if (deadlineReached()) {
        throw neopleSearchFailure('timeout')
      }

      let rawBody: string
      try {
        rawBody = await response.text()
      } catch {
        throw deadlineReached() ? neopleSearchFailure('timeout') : neopleSearchFailure('api')
      }

      if (deadlineReached()) {
        throw neopleSearchFailure('timeout')
      }

      let body: unknown
      try {
        body = JSON.parse(rawBody) as unknown
      } catch {
        throw deadlineReached()
          ? neopleSearchFailure('timeout')
          : neopleStatusFailure(response.status)
      }

      try {
        const result = projectResponse(body, response.status, response.ok)
        if (deadlineReached()) {
          throw neopleSearchFailure('timeout')
        }
        return result
      } catch (error) {
        if (deadlineReached()) {
          throw neopleSearchFailure('timeout')
        }
        throw error instanceof NeopleSearchFailure ? error : neopleSearchFailure('api')
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
  overrides: NeopleCharacterSearchTestDependencies
): SearchCharacters {
  return makeSearch(apiKey, { ...nativeDependencies, ...overrides })
}
