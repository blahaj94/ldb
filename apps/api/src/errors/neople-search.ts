import type { SearchErrorBody } from '../types/neople-character-search.js'

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function neopleSearchFailure(
  kind: 'internal' | 'api' | 'unavailable' | 'timeout',
): NeopleSearchFailure {
  const error = errors[kind]
  return new NeopleSearchFailure(error.status, error.code, error.message)
}

export function neopleStatusFailure(status: number): NeopleSearchFailure {
  return neopleSearchFailure(status === 429 || status === 503 ? 'unavailable' : 'api')
}

export function classifyNeopleUpstreamFailure(
  body: unknown,
  status: number,
  ok: boolean,
): NeopleSearchFailure | undefined {
  if (isObject(body) && Object.hasOwn(body, 'error')) {
    const upstreamError = body.error
    const code = isObject(upstreamError) && typeof upstreamError.code === 'string'
      ? upstreamError.code
      : undefined
    const knownError = code === undefined ? undefined : upstreamCodeErrors.get(code)
    return knownError === undefined ? neopleStatusFailure(status) : neopleSearchFailure(knownError)
  }

  return ok ? undefined : neopleStatusFailure(status)
}
