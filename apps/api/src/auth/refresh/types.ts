import type { DataSource } from 'typeorm'
import type { IssueAccessJwt } from '../access-jwt/types.js'

export interface RefreshDependencies {
  readonly dataSource: DataSource
  readonly issueAccessJwt: IssueAccessJwt
}

export interface RefreshTokens {
  tokenType: 'Bearer'
  accessToken: string
  accessTokenExpiresAt: string
  refreshToken: string
  sessionExpiresAt: string
}
