/** 원본 header pair에서 정확히 하나의 Bearer credential만 읽는다. JWT 검증은 호출자 책임이다. */
export function readBearerToken(rawHeaders: readonly string[]): string | undefined {
  const authorizations = rawHeaders.flatMap((value, index) => {
    const isName = index % 2 === 0
    if (!isName) {
      return []
    }

    const isAuthorization = value.toLowerCase() === 'authorization'
    if (!isAuthorization) {
      return []
    }

    return [rawHeaders[index + 1]]
  })
  const hasOneAuthorization = authorizations.length === 1
  if (!hasOneAuthorization) {
    return undefined
  }

  const bearer = /^Bearer ([^\s,]+)$/.exec(authorizations[0])
  return bearer?.[1]
}
