import type { NextFunction, Request, Response } from 'express'
import getRawBody from 'raw-body'
import { LOGIN, LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { LoginErrorDefinition } from '../../types/login.js'
import type { LogoutErrorDefinition } from '../logout/errors.js'
import type { RefreshErrorDefinition } from '../refresh/errors.js'
import type { AccountErrorDefinition } from '../account/errors.js'

type AuthJsonErrorCatalogEntry =
  LoginErrorDefinition | LogoutErrorDefinition | RefreshErrorDefinition | AccountErrorDefinition

type AuthJsonErrorDefinition = Readonly<{
  status: AuthJsonErrorCatalogEntry['status']
  code: AuthJsonErrorCatalogEntry['code']
  message: string
}>

export function jsonError(response: Response, definition: AuthJsonErrorDefinition): void {
  response.status(definition.status).json({
    error: { code: definition.code, message: definition.message }
  })
}

function readHeaderValues(request: Request, name: string): string[] {
  // 중복 header도 확인할 수 있도록 rawHeaders의 name/value pair를 읽는다.
  return request.rawHeaders.flatMap((value, index, headers) => {
    const isHeaderName = index % 2 === 0
    const isMatchingHeader = isHeaderName && value.toLowerCase() === name
    if (isMatchingHeader) {
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
    '/auth/logout'
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
  const hasSingleContentType = contentTypes.length === 1
  const isContentTypeSupported =
    hasSingleContentType &&
    /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentTypes[0])
  const hasDuplicateEncoding = isContentTypeSupported && contentEncodings.length > 1
  const hasSingleEncoding =
    isContentTypeSupported && !hasDuplicateEncoding && contentEncodings.length === 1
  const isEncodingUnsupported = hasSingleEncoding && !/^identity$/i.test(contentEncodings[0])
  const isMediaInvalid =
    !hasSingleContentType ||
    !isContentTypeSupported ||
    hasDuplicateEncoding ||
    isEncodingUnsupported
  if (isMediaInvalid) {
    rejectPayloadAndClose(LOGIN_ERRORS.MEDIA)
    return
  }

  // 2. 선언 길이로 조기 거절할 수 있지만 실제 byte 상한 검사는 아래 stream에서 수행한다.
  const contentLengths = readHeaderValues(request, 'content-length')
  const hasSingleContentLength = contentLengths.length === 1
  const isContentLengthDecimal = hasSingleContentLength && /^\d+$/.test(contentLengths[0])
  const isDeclaredPayloadTooLarge =
    isContentLengthDecimal && Number(contentLengths[0]) > LOGIN.jsonBytes
  if (isDeclaredPayloadTooLarge) {
    rejectPayloadAndClose(LOGIN_ERRORS.TOO_LARGE)
    return
  }

  // request 자체의 error는 library 오류의 type/status와 관계없이 정제 400이다.
  let hasRequestError = false
  const onRequestError = (): void => {
    hasRequestError = true
  }
  request.on('error', onRequestError)
  // aborted/413 이후 Node가 내는 후속 error도 소비하고 close에서 guard를 해제한다.
  request.once('close', () => request.off('error', onRequestError))

  // 선언 길이를 재검증하거나 느슨한 decoder를 사용하지 않고 실제 byte만 수집한다.
  getRawBody(request, { limit: LOGIN.jsonBytes }, (error, payload) => {
    const hasReadError = error != null
    if (hasReadError) {
      if (!hasRequestError) {
        const isRequestAborted = request.aborted || error.type === 'request.aborted'
        if (isRequestAborted) {
          return
        }
        const isPayloadTooLarge = error.type === 'entity.too.large'
        if (isPayloadTooLarge) {
          rejectPayloadAndClose(LOGIN_ERRORS.TOO_LARGE)
          return
        }
      }

      const hasSentHeaders = response.headersSent
      const isResponseDestroyed = response.destroyed
      const canSendError = !hasSentHeaders && !isResponseDestroyed
      if (canSendError) {
        jsonError(response, LOGIN_ERRORS.INVALID_REQUEST)
      }
      return
    }

    try {
      // 4. 상한 이하의 전체 body만 strict UTF-8로 해석한 뒤 JSON을 읽는다.
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      const decoded = decoder.decode(payload)
      request.body = JSON.parse(decoded) as unknown
      next()
    } catch {
      next(new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST))
    }
  })
}
