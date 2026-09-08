import type { DataSource, QueryRunner } from 'typeorm'
import type { VerifyAccessJwt } from '../auth/access-jwt/types.js'
import type { CharacterSearchResult, SearchCharacters } from '../types/neople-character-search.js'

export interface SearchClock {
  now(): number
  setTimer(callback: () => void, delay: number): unknown
  clearTimer(timer: unknown): void
}

export interface AuthenticatedSearchDependencies {
  readonly dataSource: DataSource
  readonly verifyAccessJwt: VerifyAccessJwt
  readonly apiKey: string
  readonly searchCharacters?: SearchCharacters
  readonly clock?: SearchClock
  readonly createQueryRunner?: (source: DataSource, signal: AbortSignal) => QueryRunner
}

export interface AuthenticatedSearchHttpService {
  search(
    rawHeaders: readonly string[],
    originalUrl: string,
    signal?: AbortSignal
  ): Promise<CharacterSearchResult>
  onModuleDestroy(): Promise<void>
}
