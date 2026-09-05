---
type: reference
status: active
enforcement: autonomous
scope: apps/api access JWT module
last-reviewed: 2026-09-06
---

# Access JWT 개발과 연동

`apps/api/src/auth/access-jwt/index.ts`는 DB·Nest·HTTP에 의존하지 않는 내부 factory를 제공한다. Behavior와 key lifecycle의 canonical Rule은 [`auth-session.md`](../rules/auth-session.md), exact dependency는 [`auth-runtime.md`](../rules/auth-runtime.md)다. 기본 `AppModule`에는 아직 연결하지 않는다.

## 공개 함수

`createAccessJwtIssuer(configuration)`는 초기화된 `IssueAccessJwt` 함수를, `createAccessJwtVerifier(configuration)`는 `VerifyAccessJwt` 함수를 비동기로 반환한다. 전용 타입은 `apps/api/src/auth/access-jwt/types.ts`, 오류는 `apps/api/src/auth/access-jwt/errors.ts`에 있다.

```ts
import { createAccessJwtIssuer, createAccessJwtVerifier } from './auth/access-jwt/index.js'
import type { AccessJwtVerifierConfiguration } from './auth/access-jwt/types.js'

// 설정 값과 PEM은 호출부의 승인된 secret/config 공급 경로에서 읽는다.
const verification: AccessJwtVerifierConfiguration = {
  issuer: configuredIssuer,
  audience: configuredApiAudience,
  verificationKeys: configuredPublicKeys, // [{ kid, publicKeyPem: SPKI PEM }]
}
const verifyAccessJwt = await createAccessJwtVerifier(verification)
const issueAccessJwt = await createAccessJwtIssuer({
  ...verification,
  signingKey: { kid: activeKid, privateKeyPem: activePkcs8Pem },
})

const issued = await issueAccessJwt({
  userId: user.id,
  sessionId: session.id,
  issuedAt: transactionTimeSeconds,
  idleDeadline: sessionIdleDeadlineSeconds,
})
// transaction에서 발급했다면 commit 성공을 확인한 뒤 accessToken을 전달한다.
const principal = await verifyAccessJwt(receivedAccessToken, serverTimeSeconds)
```

| 입력/출력 | 의미 |
| --- | --- |
| `issuer`, `audience` | 초기화 시 고정되는 비어 있지 않은 단일 문자열. 실제 운영 literal을 이 모듈에서 정하지 않는다. |
| `verificationKeys` | 중복 없는 `kid`와 ES256/P-256 SPKI public PEM의 목록. 하나 이상 필요하다. Verifier에는 private key가 필요 없다. |
| `signingKey` | 하나의 `kid`와 PKCS8 private PEM. 같은 kid의 public key가 등록돼 있고 실제 key 쌍이 일치해야 한다. |
| `userId`, `sessionId` | 내부 UUID의 hyphen 포함 36자 hex 표현. 검증은 대소문자를 허용하고 version을 v4로 한정하지 않으며 입력 표기를 보존한다. Provider subject를 넣지 않는다. |
| `issuedAt`, `idleDeadline` | 서버 UTC 정수 epoch seconds. `Date`나 milliseconds를 받지 않는다. 호출부가 canonical fresh T와 해당 session의 deadline을 계산한다. |
| 발급 결과 | `{ accessToken, issuedAt, expiresAt }`. Canonical exp를 반환해 호출부가 다시 계산할 필요가 없다. 매 발급 jti는 Node `randomUUID()`로 만든다. |
| 검증 입력 | Compact JWT 원문과 검증 시점의 서버 UTC 정수 epoch seconds. Client clock을 신뢰하지 않는다. |
| 검증 결과 | `{ userId, sessionId, issuedAt, expiresAt, tokenId }`. `tokenId`는 jti다. 임의 추가 claim을 권한이나 principal 필드로 전파하지 않는다. |

Factory는 설정을 복사하고 모든 key를 import·검증한 뒤 함수를 반환한다. 호출자가 원래 설정 객체를 변경해도 기존 함수의 issuer/audience/key는 바뀌지 않는다. 초기화는 listen 전에 await하며 실패를 startup 실패로 처리하는 책임은 향후 bootstrap 호출부에 있다. 환경변수 이름이나 파일 읽기·secret 공급 경로는 이 모듈이 정하지 않는다.

## 검증과 오류

Compact JWS/JSON parsing·서명은 `jose`에 위임한다. Local key map만 사용하고 token의 `jku`·`jwk` 등으로 key를 조회하지 않는다. `jose`의 일반 audience membership·typ normalization에 더해 단일 문자열 audience와 exact `at+jwt`를 검사한다. 미사용 시간 claim `nbf`가 있으면 거절하며 양의 clock tolerance를 두지 않는다. 추가 private claim은 필수 contract를 대신하지 못하고 반환 principal에서 제외된다.

실패는 `AccessJwtError`의 고정 `code`와 정제된 message로 구분한다. 하위 library error, payload, PEM, token을 `cause`나 부가 field에 넣지 않으며 모듈은 log를 남기지 않는다.

| code | 시점과 의미 |
| --- | --- |
| `INVALID_ACCESS_JWT_CONFIGURATION` | 빈 설정, key 누락, 중복 kid, 비호환 key/curve, active kid 미등록, private/public 불일치 또는 import 실패 |
| `INVALID_ACCESS_JWT_INPUT` | 발급 UUID/시간이 잘못됐거나 이미 idle 만료된 입력 |
| `ACCESS_JWT_SIGNING_FAILED` | 입력 검증 뒤 signing 실패. transaction에서 전파해 전체 rollback한다. |
| `INVALID_ACCESS_JWT` | malformed/변조 token, 비허용 header/key, 잘못된 필수 claims 또는 시간 경계 위반 |

호출부는 token·key 설정 전체나 원문 crypto 오류를 log/응답에 붙이지 않는다. HTTP status 변환은 후속 endpoint 책임이다.

## Session 통합과 운영 책임

회원·session 생성 결과에서 내부 ID와 시간만 전달하므로 해당 기능의 완료 없이 테스트할 수 있다. 함수는 현재 DB user/session의 존재·소유·활성·revocation을 조회하지 않으며, JWT 검증 성공을 그 확인의 대체물로 쓰지 않는다. 검색 활동과 계정 기능은 각각 [`auth-activity.md`](../rules/auth-activity.md)의 통합 순서를 따른다.

발급은 전달받은 T와 idle deadline을 사용한다. 호출부는 `auth-session.md`에 따라 session lock 뒤의 fresh DB 시각과 `last_active_at`으로 값을 준비하고, 이미 만료된 session을 재활성화하지 않는다. 최초 회원/session 생성·refresh/code 소비와 합성할 때는 JWT signing 실패도 전체 transaction에서 전파하며, commit 결과 불명에서는 반환 token을 성공 응답으로 보내지 않는다.

운영 key는 외부 secret에서 공급하고 boot마다 새로 만들지 않는다. 등록 verifier key 배포·active signer 전환·이전 key 제거와 90일 주기 운영은 canonical Rule 및 후속 운영 작업 책임이다. 현재 factory의 immutable key map을 교체하려면 새 설정으로 새 함수를 초기화해 호출부에서 전환한다. 자동 reload·배포·교체는 구현하지 않았다.

## 검증 범위

`apps/api/test/access-jwt.fixtures.ts`는 test 실행 중에만 EC key를 생성한다. 실제 credential이나 PEM fixture file을 사용하지 않는다. `apps/api/test/access-jwt.test.ts`와 `apps/api/test/access-jwt-keys.test.ts`는 정상 발급·외부 jose 검증, 변조·만료·claim/header 조건, 복수 key/제거, 초기화 실패·오류 정제와 설정 복사 경계를 검증한다.

```bash
pnpm --filter @ldb/api run --sequential '/^(build|lint|test|typecheck)$/'
```

Node 24의 compiled ESM·WebCrypto ES256 경로를 실제 실행한다. DB/HTTP/OAuth provider, remote JWKS cache, 실제 운영 key 공급·교체는 이 모듈의 검증 범위가 아니다.
