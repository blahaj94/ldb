import { NEOPLE_SERVER_NAMES } from '../constants/neople-character-search.js'
import { neopleSearchFailure } from '../errors/neople-search.js'
import type { NeopleCharacterSearchInput } from '../types/neople-character-search.js'

type DecodedQueryPair = { key: string; value: string }

/** Raw URL 해석과 검색 조건 검증을 순서대로 수행한다. */
export function parseCharacterSearchQuery(originalUrl: string): NeopleCharacterSearchInput {
  const pairs = decodeRawQuery(originalUrl)
  return validateSearchQuery(pairs)
}

function decodeQueryPart(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '))
  } catch {
    throw neopleSearchFailure('query')
  }
}

function decodeRawQuery(originalUrl: string): DecodedQueryPair[] {
  const questionMarkIndex = originalUrl.indexOf('?')
  const hasQuery = questionMarkIndex >= 0
  if (!hasQuery) {
    throw neopleSearchFailure('query')
  }

  // Map으로 바꾸기 전에 모든 pair를 보존해야 decoded key의 중복을 검증할 수 있다.
  const pairs: DecodedQueryPair[] = []
  for (const component of originalUrl.slice(questionMarkIndex + 1).split('&')) {
    const isEmptyComponent = component.length === 0
    if (isEmptyComponent) {
      throw neopleSearchFailure('query')
    }
    const equalsIndex = component.indexOf('=')
    const hasEquals = equalsIndex >= 0
    const key = decodeQueryPart(hasEquals ? component.slice(0, equalsIndex) : component)
    const value = decodeQueryPart(hasEquals ? component.slice(equalsIndex + 1) : '')
    pairs.push({ key, value })
  }
  return pairs
}

function validateSearchQuery(pairs: readonly DecodedQueryPair[]): NeopleCharacterSearchInput {
  const values = new Map<string, string>()
  for (const { key, value } of pairs) {
    const isAllowedKey = ['characterName', 'serverId', 'limit'].includes(key)
    const isDuplicate = values.has(key)
    const isInvalidKey = !isAllowedKey || isDuplicate
    if (isInvalidKey) {
      throw neopleSearchFailure('query')
    }
    values.set(key, value)
  }

  const characterName = values.get('characterName')
  const hasCharacterName = characterName != null
  if (!hasCharacterName) {
    throw neopleSearchFailure('query')
  }
  const codePointCount = [...characterName].length
  const hasOuterWhitespace = characterName !== characterName.trim()
  const isLengthValid = codePointCount >= 2 && codePointCount <= 12
  const isNameInvalid = hasOuterWhitespace || !isLengthValid
  if (isNameInvalid) {
    throw neopleSearchFailure('query')
  }

  const serverId = values.get('serverId') ?? 'all'
  const isAllServers = serverId === 'all'
  const isKnownServer = NEOPLE_SERVER_NAMES.has(serverId)
  const isServerValid = isAllServers || isKnownServer
  if (!isServerValid) {
    throw neopleSearchFailure('query')
  }

  const rawLimit = values.get('limit') ?? '10'
  const isDecimal = /^[0-9]+$/.test(rawLimit)
  const limit = Number(rawLimit)
  const isInRange = limit >= 1 && limit <= 200
  const isLimitValid = isDecimal && isInRange
  if (!isLimitValid) {
    throw neopleSearchFailure('query')
  }

  return { characterName, serverId, limit }
}
