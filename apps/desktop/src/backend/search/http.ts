import ky from 'ky'
import { z } from 'zod'
import { validateApiOrigin } from '../auth/protocol'
import { SEARCH_ERRORS } from '../../preload/common/types/search'
import type { CharacterSearchRow, SearchErrorCode } from '../../preload/common/types/search'

const nonblank = z.string().refine((value) => {
  const hasText = value.trim().length > 0
  return hasText
})
const responseSchema = z.object({
  rows: z.array(
    z.object({
      characterId: nonblank,
      characterName: nonblank,
      serverId: nonblank,
      serverName: z.union([z.string(), z.null()]),
      fame: z.union([z.number(), z.null()])
    })
  )
})
const internalFailureSchema = z.object({
  error: z.object({ code: z.literal('INTERNAL_SERVER_ERROR') })
})

export class SearchHttpFailure extends Error {
  constructor(readonly code: SearchErrorCode) {
    super(SEARCH_ERRORS[code].message)
    this.name = 'SearchHttpFailure'
  }
}

export type SearchHttp = (input: {
  nickname: string
  accessToken: string
  signal: AbortSignal
}) => Promise<readonly CharacterSearchRow[]>

export function createSearchHttp({
  apiOrigin,
  fetch: transport = globalThis.fetch
}: {
  apiOrigin: string
  fetch?: typeof fetch
}): SearchHttp {
  const origin = validateApiOrigin(apiOrigin)
  const client = ky.create({
    fetch: transport,
    retry: 0,
    timeout: false,
    totalTimeout: false,
    throwHttpErrors: false,
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store'
  })

  return async ({ nickname, accessToken, signal }) => {
    const response = await client.get(`${origin}/characters`, {
      searchParams: { characterName: nickname },
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal
    })
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new SearchHttpFailure('SEARCH_RESPONSE_INVALID')
    }

    const isInternalStatus = response.status === 500
    if (isInternalStatus) {
      const failure = internalFailureSchema.safeParse(body)
      if (failure.success) {
        throw new SearchHttpFailure('INTERNAL_SERVER_ERROR')
      }
    }
    const isSuccess = response.status === 200
    const parsed = responseSchema.safeParse(body)
    const isValidResponse = isSuccess && parsed.success
    if (!isValidResponse) {
      throw new SearchHttpFailure('SEARCH_RESPONSE_INVALID')
    }

    return parsed.data.rows
  }
}
