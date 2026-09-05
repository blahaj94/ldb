import { AUTH_ERRORS } from './auth.js'

const invalidMessage = '로그인 요청이 유효하지 않습니다. 다시 로그인해 주세요.'
export const LOGIN_ERRORS = {
  ...AUTH_ERRORS,
  INVALID_REQUEST: { code: 'INVALID_AUTH_REQUEST', status: 400, message: '인증 요청을 확인해 주세요.' },
  REQUEST_INVALID: { code: 'LOGIN_REQUEST_INVALID', status: 400, message: invalidMessage },
  EXCHANGE_INVALID: { code: 'LOGIN_EXCHANGE_INVALID', status: 400, message: invalidMessage },
  CANCELLED: { code: 'LOGIN_CANCELLED', status: 400, message: '로그인이 취소됐습니다.' },
  PROVIDER: { code: 'AUTH_PROVIDER_ERROR', status: 502, message: '소셜 로그인을 완료하지 못했습니다. 다시 시도해 주세요.' },
  TOO_LARGE: { code: 'REQUEST_TOO_LARGE', status: 413, message: '요청 크기를 줄여 주세요.' },
  MEDIA: { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415, message: 'JSON 형식으로 요청해 주세요.' },
} as const

export const LOGIN = {
  clientId: 'desktop', purpose: 'login', method: 'S256',
  requestSeconds: 600, codeSeconds: 60, providerDeadlineMs: 10_000,
  idleSeconds: 2_592_000, jsonBytes: 16_384,
  cookiePrefix: '__Host-ldb-login-',
  contentSecurityPolicy: "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const

export const CLEARED_LOGIN_FIELDS = {
  codeChallenge: null, method: null, launchTicketHash: null, stateHash: null,
  browserBindingHash: null, oidcNonceHash: null, providerPkceCiphertext: null,
  providerPkceIv: null, providerPkceTag: null, providerPkceKeyId: null,
  verifiedSubject: null, exchangeCodeHash: null, codeExpiresAt: null,
} as const
