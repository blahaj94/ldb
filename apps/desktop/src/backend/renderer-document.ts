export function validateDevRendererUrl(value: string): string {
  const hasWhitespaceOrBackslash = /[\s\\]/u.test(value)
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    const isC0Control = code <= 31
    const isDelete = code === 127
    const isControl = isC0Control || isDelete
    return isControl
  })
  const hasForbiddenCharacters = hasWhitespaceOrBackslash || hasControlCharacter
  if (hasForbiddenCharacters) {
    throw new Error('Invalid local renderer URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid local renderer URL')
  }
  const isHttp = url.protocol === 'http:'
  const isHttps = url.protocol === 'https:'
  const isWebProtocol = isHttp || isHttps
  const isLocalhost = url.hostname === 'localhost'
  const isIpv4Loopback = url.hostname === '127.0.0.1'
  const isIpv6Loopback = url.hostname === '[::1]'
  const isLoopback = isLocalhost || isIpv4Loopback || isIpv6Loopback
  const hasCredentials = url.username.length > 0 || url.password.length > 0
  const isCanonicalUrl = value === url.href
  // Electron Vite는 dev origin을 마지막 slash 없이 제공한다.
  const isBareOrigin = value === url.origin
  const isRootDocument = url.href === `${url.origin}/`
  const isViteOrigin = isBareOrigin && isRootDocument
  const hasCanonicalInput = isCanonicalUrl || isViteOrigin
  const isAllowed = isWebProtocol && isLoopback && !hasCredentials && hasCanonicalInput
  if (!isAllowed) {
    throw new Error('Invalid local renderer URL')
  }
  return url.href
}
