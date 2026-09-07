import { Controller, Get, Inject, Patch, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { ACCOUNT_ERRORS, AccountFailure } from './errors.js'
import type { AccountHttpService } from './types.js'

export const ACCOUNT_SERVICE = Symbol('ACCOUNT_SERVICE')

@Controller('me')
export class AccountController {
  constructor(@Inject(ACCOUNT_SERVICE) private readonly service: AccountHttpService) {}

  @Get()
  async get(@Req() request: Request, @Res() response: Response): Promise<void> {
    const isGet = request.method === 'GET'
    if (!isGet) throw new AccountFailure(ACCOUNT_ERRORS.INVALID_REQUEST)
    const profile = await this.service.get(request.rawHeaders)
    response.status(200).json(profile)
  }

  @Patch('nickname')
  async nickname(@Req() request: Request, @Res() response: Response): Promise<void> {
    const profile = await this.service.updateNickname(request.rawHeaders, request.body)
    response.status(200).json(profile)
  }
}
