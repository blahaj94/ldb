import { Controller, Get, Inject, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { neopleSearchFailure } from '../errors/neople-search.js'
import type { AuthenticatedSearchHttpService } from './types.js'

export const CHARACTER_SEARCH_SERVICE = Symbol('CHARACTER_SEARCH_SERVICE')

@Controller('characters')
export class CharacterSearchController {
  constructor(
    @Inject(CHARACTER_SEARCH_SERVICE) private readonly service: AuthenticatedSearchHttpService
  ) {}

  @Get()
  async search(@Req() request: Request, @Res() response: Response): Promise<void> {
    const isGet = request.method === 'GET'
    if (!isGet) {
      throw neopleSearchFailure('query')
    }
    const controller = new AbortController()
    const cancelDisconnectedRequest = (): void => {
      const isComplete = response.writableFinished
      if (!isComplete) {
        controller.abort()
      }
    }
    response.once('close', cancelDisconnectedRequest)
    try {
      const result = await this.service.search(
        request.rawHeaders,
        request.originalUrl,
        controller.signal
      )
      const canRespond = !response.destroyed
      if (canRespond) {
        response.status(200).json(result)
      }
    } finally {
      response.removeListener('close', cancelDisconnectedRequest)
    }
  }
}
