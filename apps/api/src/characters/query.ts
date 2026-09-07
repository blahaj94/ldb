import { NEOPLE_SERVER_NAMES } from '../constants/neople-character-search.js'
import { neopleSearchFailure } from '../errors/neople-search.js'
import type { NeopleCharacterSearchInput } from '../types/neople-character-search.js'

function decodeQueryPart(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '))
  } catch {
    throw neopleSearchFailure('query')
  }
}

/** Express의 coercion 전에 originalUrl을 한 번만 strict decode한다. */
export function parseCharacterSearchQuery(originalUrl: string): NeopleCharacterSearchInput {
  const question = originalUrl.indexOf('?')
  const hasQuery = question >= 0
  if (!hasQuery) throw neopleSearchFailure('query')

  const values = new Map<string, string>()
  for (const component of originalUrl.slice(question + 1).split('&')) {
    const isEmptyComponent = component.length === 0
    if (isEmptyComponent) throw neopleSearchFailure('query')
    const equals = component.indexOf('=')
    const hasEquals = equals >= 0
    const key = decodeQueryPart(hasEquals ? component.slice(0, equals) : component)
    const value = decodeQueryPart(hasEquals ? component.slice(equals + 1) : '')
    const isAllowedKey = ['characterName', 'serverId', 'limit'].includes(key)
    const isDuplicate = values.has(key)
    const isInvalidKey = !isAllowedKey || isDuplicate
    if (isInvalidKey) throw neopleSearchFailure('query')
    values.set(key, value)
  }

  const characterName = values.get('characterName')
  const hasCharacterName = characterName != null
  if (!hasCharacterName) throw neopleSearchFailure('query')
  const length = [...characterName].length
  const hasOuterWhitespace = characterName !== characterName.trim()
  const isLengthValid = length >= 2 && length <= 12
  const isNameInvalid = hasOuterWhitespace || !isLengthValid
  if (isNameInvalid) throw neopleSearchFailure('query')

  const serverId = values.get('serverId') ?? 'all'
  const isAllServers = serverId === 'all'
  const isKnownServer = NEOPLE_SERVER_NAMES.has(serverId)
  const isServerValid = isAllServers || isKnownServer
  if (!isServerValid) throw neopleSearchFailure('query')

  const rawLimit = values.get('limit') ?? '10'
  const isDecimal = /^[0-9]+$/.test(rawLimit)
  const limit = Number(rawLimit)
  const isInRange = limit >= 1 && limit <= 200
  const isLimitValid = isDecimal && isInRange
  if (!isLimitValid) throw neopleSearchFailure('query')

  return { characterName, serverId, limit }
}
