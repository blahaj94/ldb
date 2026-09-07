import type { DataSource } from 'typeorm'
import type { VerifyAccessJwt } from '../access-jwt/types.js'

export interface AccountDependencies {
  readonly dataSource: DataSource
  readonly verifyAccessJwt: VerifyAccessJwt
}

export interface AccountProfile {
  user: {
    id: string
    nickname: string
  }
}

export interface AccountHttpService {
  get(rawHeaders: readonly string[]): Promise<AccountProfile>
  updateNickname(rawHeaders: readonly string[], body: unknown): Promise<AccountProfile>
}
