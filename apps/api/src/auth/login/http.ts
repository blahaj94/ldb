import 'reflect-metadata'
import { Catch, Controller, Get, Inject, Module, Post, Req, Res } from '@nestjs/common'
import type { ArgumentsHost, ExceptionFilter, INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { Request, Response } from 'express'
import { LOGIN, LOGIN_ERRORS } from '../../constants/login.js'
import { LoginFailure, loginFailure } from '../../errors/login.js'
import type { AuthProvider } from '../../types/auth.js'
import type { LoginHttpService } from '../../types/login.js'
import { parseCallback, parseCreation, parseExchange } from './input.js'
import { jsonError, loginJsonParser } from './json-parser.js'

const LOGIN_SERVICE = Symbol('LOGIN_SERVICE')
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)

function page(message: string, returnUrl?: string): string {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>로그인</title><body><p>${escapeHtml(message)}</p>${returnUrl ? `<a href="${escapeHtml(returnUrl)}">앱으로 돌아가기</a>` : ''}</body></html>`
}

function rawQuery(request: Request): URLSearchParams {
  return new URL(request.originalUrl, 'https://request.invalid').searchParams
}

@Catch()
class LoginHttpFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp()
    const request = context.getRequest<Request>(), response = context.getResponse<Response>()
    const failure = loginFailure(error)
    if (response.headersSent) { response.end(); return }
    if (request.method === 'GET') response.status(failure.status).type('html').send(page(failure.message))
    else jsonError(response, failure)
  }
}

@Controller('auth')
class LoginController {
  constructor(@Inject(LOGIN_SERVICE) private readonly service: LoginHttpService) {}

  @Post('login-requests')
  async create(@Req() request: Request, @Res() response: Response): Promise<void> {
    response.status(201).json(await this.service.create(parseCreation(request.body)))
  }

  @Post('exchange')
  async exchange(@Req() request: Request, @Res() response: Response): Promise<void> {
    response.status(200).json(await this.service.exchange(parseExchange(request.body)))
  }

  @Get('login/authorize')
  async authorize(@Req() request: Request, @Res() response: Response): Promise<void> {
    const query = rawQuery(request)
    if (query.size !== 1 || query.getAll('ticket').length !== 1) throw new LoginFailure(LOGIN_ERRORS.REQUEST_INVALID)
    const result = await this.service.authorize(query.get('ticket')!)
    response.setHeader('Set-Cookie', result.cookie)
    response.status(303).setHeader('Location', result.redirectUrl)
    response.end()
  }

  @Get('callback/google')
  google(@Req() request: Request, @Res() response: Response): Promise<void> { return this.callback('google', request, response) }

  @Get('callback/discord')
  discord(@Req() request: Request, @Res() response: Response): Promise<void> { return this.callback('discord', request, response) }

  private async callback(provider: AuthProvider, request: Request, response: Response): Promise<void> {
    const query = rawQuery(request)
    parseCallback(query)
    const result = await this.service.callback(provider, query, request.headers.cookie ?? '')
    response.setHeader('Set-Cookie', result.cookie)
    response.status(200).type('html').send(page('앱으로 돌아가 로그인을 완료해 주세요.', result.returnUrl))
  }
}

/** 실제 server composition 또는 격리 test가 service를 주입한다. 환경변수 test mode는 없다. */
export async function createLoginHttpApp(service: LoginHttpService): Promise<INestApplication> {
  @Module({ controllers: [LoginController], providers: [{ provide: LOGIN_SERVICE, useValue: service }] })
  class LoginHttpModule {}
  const app = await NestFactory.create(LoginHttpModule, { logger: false, bodyParser: false })
  app.use((request: Request, response: Response, next: () => void) => {
    response.setHeader('Cache-Control', 'no-store')
    response.removeHeader('X-Powered-By')
    if (request.method === 'GET') {
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.setHeader('Content-Security-Policy', LOGIN.contentSecurityPolicy)
    }
    next()
  })
  app.use(loginJsonParser)
  app.useGlobalFilters(new LoginHttpFilter())
  return app
}
