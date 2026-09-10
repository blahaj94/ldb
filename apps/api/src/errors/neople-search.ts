import type { SearchErrorBody } from '../types/neople-character-search.js'

const errors = {
  query: {
    status: 400,
    code: 'INVALID_SEARCH_QUERY',
    message: '검색 조건을 확인해 주세요.'
  },
  authentication: {
    status: 401,
    code: 'AUTHENTICATION_REQUIRED',
    message: '로그인이 필요합니다.'
  },
  limited: {
    status: 429,
    code: 'SEARCH_RATE_LIMITED',
    message: '검색 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'
  },
  internal: {
    status: 500,
    code: 'INTERNAL_SERVER_ERROR',
    message: '서버 오류로 검색을 처리하지 못했습니다.'
  },
  api: {
    status: 502,
    code: 'NEOPLE_API_ERROR',
    message: '캐릭터 검색 중 오류가 발생했습니다.'
  },
  unavailable: {
    status: 503,
    code: 'NEOPLE_UNAVAILABLE',
    message: '현재 캐릭터 검색을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'
  },
  timeout: {
    status: 504,
    code: 'NEOPLE_TIMEOUT',
    message: '캐릭터 검색 응답 시간이 초과됐습니다. 다시 시도해 주세요.'
  }
} as const satisfies Record<string, { status: number; code: string; message: string }>

type SearchErrorDefinition = (typeof errors)[keyof typeof errors]

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
  ['DNF999', 'api']
])

export class NeopleSearchFailure extends Error {
  readonly body: SearchErrorBody
  readonly status: SearchErrorDefinition['status']

  constructor(
    definition: SearchErrorDefinition,
    readonly retryAfter?: number
  ) {
    super(definition.message)
    this.name = 'NeopleSearchFailure'
    this.status = definition.status
    this.body = { error: { code: definition.code, message: definition.message } }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  const hasObjectType = typeof value === 'object'
  if (!hasObjectType) {
    return false
  }

  const isNotNull = value !== null
  if (!isNotNull) {
    return false
  }

  const isNonArrayObject = !Array.isArray(value)

  return isNonArrayObject
}

export function neopleSearchFailure(
  kind: keyof typeof errors,
  retryAfter?: number
): NeopleSearchFailure {
  const error = errors[kind]
  return new NeopleSearchFailure(error, retryAfter)
}

export function neopleStatusFailure(status: number): NeopleSearchFailure {
  const isRateLimited = status === 429
  const isUnavailable = status === 503
  const isTemporarilyUnavailable = isRateLimited || isUnavailable
  const failureKind = isTemporarilyUnavailable ? 'unavailable' : 'api'

  return neopleSearchFailure(failureKind)
}

export function classifyNeopleUpstreamFailure(
  body: unknown,
  status: number,
  ok: boolean
): NeopleSearchFailure | undefined {
  const isBodyObject = isObject(body)
  if (!isBodyObject) {
    const hasHttpFailure = !ok
    return hasHttpFailure ? neopleStatusFailure(status) : undefined
  }

  const hasError = Object.hasOwn(body, 'error')
  if (!hasError) {
    const hasHttpFailure = !ok
    return hasHttpFailure ? neopleStatusFailure(status) : undefined
  }

  const upstreamError = body.error
  const isUpstreamErrorObject = isObject(upstreamError)
  if (!isUpstreamErrorObject) {
    return neopleStatusFailure(status)
  }

  const hasStringCode = typeof upstreamError.code === 'string'
  const code = hasStringCode ? (upstreamError.code as string) : undefined
  const hasCode = code !== undefined
  const knownError = hasCode ? upstreamCodeErrors.get(code) : undefined
  const isKnownError = knownError !== undefined

  return isKnownError ? neopleSearchFailure(knownError) : neopleStatusFailure(status)
}
