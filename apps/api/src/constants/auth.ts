export const AUTH_PROVIDERS = {
  GOOGLE: 'google',
  DISCORD: 'discord'
} as const

export const AUTH_ERRORS = {
  INTERNAL: {
    code: 'AUTH_INTERNAL_ERROR',
    status: 500,
    message: '인증 요청을 처리하지 못했습니다.'
  },
  UNAVAILABLE: {
    code: 'AUTH_UNAVAILABLE',
    status: 503,
    message: '현재 계정 기능을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.'
  }
} as const

export const INITIAL_NICKNAME = { prefix: '모험가', digits: 6 } as const

export const REFRESH_TOKEN = {
  byteLength: 32,
  encoding: 'base64url',
  hashAlgorithm: 'sha256'
} as const
