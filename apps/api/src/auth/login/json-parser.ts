import type { NextFunction, Request, Response } from 'express'
import { LOGIN, LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure } from '../../errors/login.js'
import type { LoginErrorDefinition } from '../../types/login.js'

export function jsonError(response: Response, definition: Pick<LoginFailure, 'status' | 'code' | 'message'>): void {
  response.status(definition.status).json({ error: { code: definition.code, message: definition.message } })
}

function headers(request: Request, name: string): string[] {
  return request.rawHeaders.flatMap((value, index, all) => index % 2 === 0 && value.toLowerCase() === name ? [all[index + 1]] : [])
}

/** Nest/Express parser를 끈 app에서 가장 먼저 실제 payload stream을 제한한다. */
export function loginJsonParser(request: Request, response: Response, next: NextFunction): void {
  const path = request.path.toLowerCase().replace(/\/+$/, '')
  if (request.method !== 'POST' || !['/auth/login-requests', '/auth/exchange'].includes(path)) { next(); return }
  const media = headers(request, 'content-type'), encoding = headers(request, 'content-encoding')
  const rejectAndClose = (definition: LoginErrorDefinition): void => {
    request.pause()
    response.setHeader('Connection', 'close')
    jsonError(response, definition)
  }
  if (media.length !== 1 || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(media[0]) ||
    encoding.length > 1 || (encoding.length === 1 && !/^identity$/i.test(encoding[0]))) {
    rejectAndClose(LOGIN_ERRORS.MEDIA)
    return
  }
  const declared = headers(request, 'content-length')
  if (declared.length === 1 && /^\d+$/.test(declared[0]) && Number(declared[0]) > LOGIN.jsonBytes) {
    rejectAndClose(LOGIN_ERRORS.TOO_LARGE)
    return
  }
  const chunks: Buffer[] = []
  let length = 0
  let done = false
  const clear = (): void => {
    done = true
    chunks.length = 0
    request.off('data', data)
    request.off('end', end)
  }
  const data = (chunk: Buffer): void => {
    if (done) return
    length += chunk.length
    if (length > LOGIN.jsonBytes) {
      clear()
      rejectAndClose(LOGIN_ERRORS.TOO_LARGE)
      return
    }
    chunks.push(chunk)
  }
  const end = (): void => {
    if (done) return
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, length))
      request.body = JSON.parse(decoded) as unknown
      clear()
      next()
    } catch {
      clear()
      next(new LoginFailure(LOGIN_ERRORS.INVALID_REQUEST))
    }
  }
  request.on('data', data)
  request.once('end', end)
  request.once('error', () => {
    if (done) return
    clear()
    if (!response.headersSent && !response.destroyed) jsonError(response, LOGIN_ERRORS.INVALID_REQUEST)
  })
  request.once('aborted', clear)
}
