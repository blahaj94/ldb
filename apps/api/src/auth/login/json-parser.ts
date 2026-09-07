import type { NextFunction, Request, Response } from 'express'
import { LOGIN, LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { LoginErrorDefinition } from '../../types/login.js'
import type { LogoutErrorDefinition } from '../logout/errors.js'
import type { RefreshErrorDefinition } from '../refresh/errors.js'
import type { AccountErrorDefinition } from '../account/errors.js'

type AuthJsonErrorCatalogEntry =
  | LoginErrorDefinition
  | LogoutErrorDefinition
  | RefreshErrorDefinition
  | AccountErrorDefinition

type AuthJsonErrorDefinition = Readonly<{
  status: AuthJsonErrorCatalogEntry['status']
  code: AuthJsonErrorCatalogEntry['code']
  message: string
}>

export function jsonError(
  response: Response,
  definition: AuthJsonErrorDefinition,
): void {
  response.status(definition.status).json({
    error: { code: definition.code, message: definition.message },
  })
}

function readHeaderValues(request: Request, name: string): string[] {
  // 중복 header도 확인할 수 있도록 rawHeaders의 name/value pair를 읽는다.
  return request.rawHeaders.flatMap((value, index, headers) => {
    const isHeaderName = index % 2 === 0
    if (isHeaderName && value.toLowerCase() === name) {
      return [headers[index + 1]]
    }
    return []
  })
}

/** Nest/Express parser를 끈 app에서 가장 먼저 실제 payload stream을 제한한다. */
export function loginJsonParser(request: Request, response: Response, next: NextFunction): void {
  const path = request.path.toLowerCase().replace(/\/+$/, '')
  const isPost = request.method === 'POST'
  const isAuthJsonPath = [
    '/auth/login-requests',
    '/auth/exchange',
    '/auth/refresh',
    '/auth/logout',
  ].includes(path)
  const isAuthPost = isPost && isAuthJsonPath
  const isPatch = request.method === 'PATCH'
  const isNicknamePath = path === '/me/nickname'
  const isNicknamePatch = isPatch && isNicknamePath
  const shouldParseAuthJson = isAuthPost || isNicknamePatch
  if (!shouldParseAuthJson) {
    next()
    return
  }

  const contentTypes = readHeaderValues(request, 'content-type')
  const contentEncodings = readHeaderValues(request, 'content-encoding')
  const rejectPayloadAndClose = (definition: LoginErrorDefinition): void => {
    request.pause()
    response.setHeader('Connection', 'close')
    jsonError(response, definition)
  }

  // 1. Media/encoding 오류를 크기·JSON 오류보다 먼저 거절한다.
  if (
    contentTypes.length !== 1 ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentTypes[0]) ||
    contentEncodings.length > 1 ||
    (contentEncodings.length === 1 && !/^identity$/i.test(contentEncodings[0]))
  ) {
    rejectPayloadAndClose(LOGIN_ERRORS.MEDIA)
    return
  }

  // 2. 선언 길이로 조기 거절할 수 있지만 실제 byte 상한 검사는 아래 stream에서 수행한다.
  const contentLengths = readHeaderValues(request, 'content-length')
  if (
    contentLengths.length === 1 &&
    /^\d+$/.test(contentLengths[0]) &&
    Number(contentLengths[0]) > LOGIN.jsonBytes
  ) {
    rejectPayloadAndClose(LOGIN_ERRORS.TOO_LARGE)
    return
  }

  const chunks: Buffer[] = []
  let receivedBytes = 0
  let finished = false

  const clearPayload = (): void => {
    finished = true
    chunks.length = 0
    request.off('data', onData)
    request.off('end', onEnd)
  }

  const onData = (chunk: Buffer): void => {
    if (finished) {
      return
    }

    // 3. 초과 chunk는 저장하지 않고 body 종료 전에 연결을 닫는다.
    receivedBytes += chunk.length
    if (receivedBytes > LOGIN.jsonBytes) {
      clearPayload()
      rejectPayloadAndClose(LOGIN_ERRORS.TOO_LARGE)
      return
    }
    chunks.push(chunk)
  }

  const onEnd = (): void => {
    if (finished) {
      return
    }

    try {
      // 4. 상한 이하의 전체 body만 strict UTF-8로 해석한 뒤 JSON을 읽는다.
      const payload = Buffer.concat(chunks, receivedBytes)
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      const decoded = decoder.decode(payload)
      request.body = JSON.parse(decoded) as unknown
      clearPayload()
      next()
    } catch {
      clearPayload()
      next(new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST))
    }
  }

  request.on('data', onData)
  request.once('end', onEnd)
  request.once('error', () => {
    if (finished) {
      return
    }
    clearPayload()
    if (!response.headersSent && !response.destroyed) {
      jsonError(response, LOGIN_ERRORS.INVALID_REQUEST)
    }
  })
  request.once('aborted', clearPayload)
}
