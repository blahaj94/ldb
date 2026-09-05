export interface AccessJwtVerifierConfiguration {
  readonly issuer: string
  readonly audience: string
  readonly verificationKeys: readonly {
    readonly kid: string
    readonly publicKeyPem: string
  }[]
}

export interface AccessJwtIssuerConfiguration extends AccessJwtVerifierConfiguration {
  readonly signingKey: {
    readonly kid: string
    readonly privateKeyPem: string
  }
}

export interface AccessJwtIssueInput {
  readonly userId: string
  readonly sessionId: string
  readonly issuedAt: number
  readonly idleDeadline: number
}

export interface IssuedAccessJwt {
  readonly accessToken: string
  readonly issuedAt: number
  readonly expiresAt: number
}

// 서명·claim 검증 결과다. DB의 존재·활성·소유 확인을 포함하지 않는다.
export interface AccessJwtPrincipal {
  readonly userId: string
  readonly sessionId: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly tokenId: string
}

export type IssueAccessJwt = (input: AccessJwtIssueInput) => Promise<IssuedAccessJwt>
export type VerifyAccessJwt = (token: unknown, now: number) => Promise<AccessJwtPrincipal>
