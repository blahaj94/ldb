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
  const hasObjectType = typeof value === 'object'
  const isNotNull = hasObjectType && value !== null
  const isNonArrayObject = isNotNull && !Array.isArray(value)

  return isNonArrayObject
}

function projectResponse(body: unknown, status: number, ok: boolean): CharacterSearchResult {
  const upstreamFailure = classifyNeopleUpstreamFailure(body, status, ok)
  const hasUpstreamFailure = upstreamFailure !== undefined
  if (hasUpstreamFailure) {
    throw upstreamFailure
  }

  const isBodyObject = isObject(body)
  if (!isBodyObject) {
    throw neopleSearchFailure('api')
  }

  const hasRowsArray = Array.isArray(body.rows)
  if (!hasRowsArray) {
    throw neopleSearchFailure('api')
  }

  const upstreamRows = body.rows as unknown[]
  const rows = upstreamRows.map((candidate): CharacterCandidate => {
    const isCandidateObject = isObject(candidate)
    if (!isCandidateObject) {
      throw neopleSearchFailure('api')
    }

    const { characterId, characterName, serverId } = candidate
    const isCharacterIdString = typeof characterId === 'string'
    const isCharacterIdBlank = isCharacterIdString && characterId.trim() === ''
    const isCharacterIdInvalid = !isCharacterIdString || isCharacterIdBlank
    if (isCharacterIdInvalid) {
      throw neopleSearchFailure('api')
    }

    const isCharacterNameString = typeof characterName === 'string'
    const isCharacterNameBlank = isCharacterNameString && characterName.trim() === ''
    const isCharacterNameInvalid = !isCharacterNameString || isCharacterNameBlank
    if (isCharacterNameInvalid) {
      throw neopleSearchFailure('api')
    }

    const isServerIdString = typeof serverId === 'string'
    const isServerIdBlank = isServerIdString && serverId.trim() === ''
    const isServerIdInvalid = !isServerIdString || isServerIdBlank
    if (isServerIdInvalid) {
      throw neopleSearchFailure('api')
    }

    const rawFame = candidate.fame
    const isFameDefined = rawFame !== undefined
    const isFameNotNull = isFameDefined && rawFame !== null
    const hasFame = isFameDefined && isFameNotNull
    const isFameNumber = hasFame && typeof rawFame === 'number'
    const isFameFinite = isFameNumber && Number.isFinite(rawFame)
    const isFameInvalid = hasFame && (!isFameNumber || !isFameFinite)
    if (isFameInvalid) {
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
      const isTimerPending = !didTimeout
      const isBeforeDeadline = isTimerPending && dependencies.now() < deadline
      const canContinue = isTimerPending && isBeforeDeadline
      if (canContinue) {
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
        const didReachDeadline = deadlineReached()
        const failure = didReachDeadline
          ? neopleSearchFailure('timeout')
          : neopleSearchFailure('api')
        throw failure
      }

      const didReachDeadlineAfterHeaders = deadlineReached()
      if (didReachDeadlineAfterHeaders) {
        throw neopleSearchFailure('timeout')
      }

      let rawBody: string
      try {
        rawBody = await response.text()
      } catch {
        const didReachDeadline = deadlineReached()
        const failure = didReachDeadline
          ? neopleSearchFailure('timeout')
          : neopleSearchFailure('api')
        throw failure
      }

      const didReachDeadlineAfterBody = deadlineReached()
      if (didReachDeadlineAfterBody) {
        throw neopleSearchFailure('timeout')
      }

      let body: unknown
      try {
        body = JSON.parse(rawBody) as unknown
      } catch {
        const didReachDeadline = deadlineReached()
        throw didReachDeadline
          ? neopleSearchFailure('timeout')
          : neopleStatusFailure(response.status)
      }

      try {
        const result = projectResponse(body, response.status, response.ok)
        const didReachDeadlineAfterProjection = deadlineReached()
        if (didReachDeadlineAfterProjection) {
          throw neopleSearchFailure('timeout')
        }
        return result
      } catch (error) {
        const didReachDeadline = deadlineReached()
        if (didReachDeadline) {
          throw neopleSearchFailure('timeout')
        }
        const isSearchFailure = error instanceof NeopleSearchFailure
        const failure = isSearchFailure ? error : neopleSearchFailure('api')
        throw failure
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
