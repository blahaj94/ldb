import { isCanonicalOpaque } from './pkce'

const MAX_URL_BYTES = 2_048
const INCOMPATIBLE_APP_PROTOCOLS = new Set([
  'about:',
  'blob:',
  'data:',
  'file:',
  'ftp:',
  'http:',
  'https:',
  'javascript:',
  'mailto:',
  'ws:',
  'wss:'
])

function hasForbiddenUrlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    const isControlOrSpace = codePoint <= 0x20 || codePoint === 0x7f
    const isBackslash = character === '\\'
    const isForbidden = isControlOrSpace || isBackslash
    if (isForbidden) {
      return true
    }
  }
  return false
}

export class AuthProtocolFailure extends Error {
  constructor() {
    super('Authentication URL is invalid.')
    this.name = 'AuthProtocolFailure'
    this.stack = `${this.name}: ${this.message}`
  }
}

function parseExactUrl(raw: unknown): URL {
  const isString = typeof raw === 'string'
  const isWithinLimit = isString && Buffer.byteLength(raw, 'utf8') <= MAX_URL_BYTES
  const hasForbiddenCharacter = isString && hasForbiddenUrlCharacter(raw)
  const canParse = isString && isWithinLimit && !hasForbiddenCharacter
  if (!canParse) {
    throw new AuthProtocolFailure()
  }

  try {
    return new URL(raw)
  } catch {
    throw new AuthProtocolFailure()
  }
}

export function validateApiOrigin(apiOrigin: string): string {
  const url = parseExactUrl(apiOrigin)
  const isHttps = url.protocol === 'https:'
  const hasNoUsername = url.username.length === 0
  const hasNoPassword = hasNoUsername && url.password.length === 0
  const hasNoCredentials = hasNoUsername && hasNoPassword
  const hasRootPath = url.pathname === '/'
  const hasNoQuery = url.search.length === 0
  const hasNoFragment = url.hash.length === 0
  const isCanonicalOrigin = url.origin === apiOrigin
  const isValidOrigin =
    isHttps && hasNoCredentials && hasRootPath && hasNoQuery && hasNoFragment && isCanonicalOrigin
  if (!isValidOrigin) {
    throw new AuthProtocolFailure()
  }

  return apiOrigin
}

export function validateReturnTarget(returnTarget: string): string {
  const url = parseExactUrl(returnTarget)
  // 실제 owned scheme 값은 bootstrap이 주입한다. Browser/network가 이미 소유한 built-in만 제외한다.
  const isPrivateScheme = !INCOMPATIBLE_APP_PROTOCOLS.has(url.protocol)
  const hasNoUsername = url.username.length === 0
  const hasNoPassword = hasNoUsername && url.password.length === 0
  const hasNoCredentials = hasNoUsername && hasNoPassword
  const hasNoPort = url.port.length === 0
  const hasNoQuery = !returnTarget.includes('?')
  const hasNoFragment = !returnTarget.includes('#')
  const isCanonicalTarget = url.toString() === returnTarget
  const isValidTarget =
    isPrivateScheme &&
    hasNoCredentials &&
    hasNoPort &&
    hasNoQuery &&
    hasNoFragment &&
    isCanonicalTarget
  if (!isValidTarget) {
    throw new AuthProtocolFailure()
  }

  return returnTarget
}

export function validateBrowserLaunchUrl(raw: unknown, apiOrigin: string): string {
  const trustedOrigin = validateApiOrigin(apiOrigin)
  const url = parseExactUrl(raw)
  const tickets = url.searchParams.getAll('ticket')
  const hasOneQueryParameter = url.searchParams.size === 1
  const hasOneTicket = hasOneQueryParameter && tickets.length === 1
  const hasOneQuery = hasOneQueryParameter && hasOneTicket
  const ticket = tickets[0]
  const isCanonicalTicket = isCanonicalOpaque(ticket)
  const expected = isCanonicalTicket
    ? `${trustedOrigin}/auth/login/authorize?ticket=${ticket}`
    : null
  const hasExpectedLaunchUrl = expected != null
  const isExactLaunchUrl = hasExpectedLaunchUrl && raw === expected
  const isValidLaunchUrl = hasOneQuery && isCanonicalTicket && isExactLaunchUrl
  if (!isValidLaunchUrl) {
    throw new AuthProtocolFailure()
  }

  return expected
}

export function parseReturnUrl(raw: unknown, returnTarget: string): Readonly<{ code: string }> {
  const trustedTarget = validateReturnTarget(returnTarget)
  const url = parseExactUrl(raw)
  const codes = url.searchParams.getAll('code')
  const hasOneQueryParameter = url.searchParams.size === 1
  const hasOneCode = hasOneQueryParameter && codes.length === 1
  const hasOneQuery = hasOneQueryParameter && hasOneCode
  const code = codes[0]
  const isCanonicalCode = isCanonicalOpaque(code)
  const expected = isCanonicalCode ? `${trustedTarget}?code=${code}` : null
  const hasExpectedReturnUrl = expected != null
  const isExactReturnUrl = hasExpectedReturnUrl && raw === expected
  const isValidReturnUrl = hasOneQuery && isCanonicalCode && isExactReturnUrl
  if (!isValidReturnUrl) {
    throw new AuthProtocolFailure()
  }

  return { code }
}
