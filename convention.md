---
type: rule
status: active
enforcement: warning
scope: repository handwritten source, tests, scripts and tooling
last-reviewed: 2026-09-06
rationale: 의미별 검사와 처리 결과를 이름으로 읽고 개별 boolean 값을 debug할 수 있도록 프로젝트 전체의 작성 기준을 통일한다.
evidence: "PR #59·#64 가독성 검토, PR #71 사용자 리뷰와 후속 convention 인터뷰"
exceptions: generated/vendor 산출물은 직접 수정하지 않으며 기존 architecture·domain·security·library 계약과 평가 의미를 보존한다.
review-after: 승인 후 서로 다른 app 또는 tooling의 코드 PR 3개에 적용한 시점
---

# Project Convention

## 적용 범위와 권한

프로젝트에서 직접 작성하는 모든 코드의 공통 작성·수정·review 기준이다. API, Web, Desktop의 main/preload/renderer, package, script, tooling과 test에 동일하게 적용한다. 파일 위치나 언어가 다르다는 이유로 제외하지 않는다.

이 Rule은 [PR #75의 사용자 승인](https://github.com/blahaj94/ldb/pull/75#issuecomment-5558145217)을 반영한다. 새 코드와 수정·review하는 기존 코드에 적용하며, 전체 기존 코드의 일괄 refactor를 자동으로 시작하지 않는다. 이후 변경은 [Change Control](docs/rules/change-control.md)을 따른다.

Generated/vendor 코드는 산출물을 직접 고치지 않고 소유한 생성 source나 template에서 기준을 적용한다. 실행 조건이 없는 정적 markup·선언·data에 boolean을 만들지는 않는다. JSX의 조건부 렌더링이나 설정·query 생성 코드처럼 판단이 있는 곳에는 같은 기준을 적용한다.

승인된 architecture·domain·security·API 계약과 가장 가까운 `AGENTS.md`의 구체적인 경계를 유지한다. 문법이나 library 계약 때문에 같은 표현을 사용할 수 없으면 같은 의미의 이름·검사 결과를 드러내는 표현을 선택하고 제한과 근거를 review에 기록한다. 충돌은 기존 change-control 절차를 따른다.

## 읽기 안내

역할별 시작점은 [`docs/README.md`](docs/README.md#역할별-시작점)를 따른다. Code 작성·수정에서는 적용 범위와 권한 및 1–6의 규칙 본문을 확인해 적용 여부를 판단한다. Code 예시와 근거는 의미가 불명확하거나 해당 pattern을 다룰 때 읽는다. Read-only review는 아래 checklist에서 해당 규칙 본문으로 확장한다. Code 없는 문서 작업에는 전문을 요구하지 않지만 code 예시를 수정하면 해당 기준을 확인한다. 읽기 순서가 기준의 적용 범위나 기존 approval·testing 의무를 줄이지 않는다.

여섯 세부 기준의 승인 전 초안은 [`코드 표현과 함수 입력 가독성 제안`](docs/rules/code-expression.md)에 있다. `proposed` 상태이며 이 문서의 기존 active 규칙과 구분한다. 승인 전에는 구현 기준으로 적용하지 않는다.

## 1. 처리 순서와 결과가 보이는 주 흐름

- 진입 함수에서 입력 확인, 주요 처리 단계, 외부 호출, 상태 변경과 결과 반환을 찾을 수 있어야 한다. 작업에 없는 단계를 형식적으로 추가하지 않는다.
- 여러 단계는 빈 줄과 의미 있는 이름으로 구분한다. Test도 준비·실행·검증을 따라 읽을 수 있게 작성한다.
- 성공, 거절, 실패 정리 뒤 남는 상태와 결과 전달 시점을 드러낸다. 내부 helper의 DB 변경·외부 호출·cleanup도 호출자가 예상할 수 있어야 한다.
- Transaction과 실패 결과를 함께 보여 주는 함수는 길이만으로 분리하지 않는다. 하나의 실제 작업을 맡는 helper로 나눌 때도 commit·rollback·release 이후 결과 경계를 보존한다.
- 같은 Error의 return/throw 차이나 선택 인자의 유무에 commit·rollback 정책을 숨기지 않는다. 실패 정리의 commit 뒤 거절과 전체 rollback을 이름·결과 type·제어 흐름으로 구분한다.
- Result union은 가능한 표현 수단이다. 모든 함수의 Result type이나 공통 transaction framework를 의무화하지 않는다. Library 관례를 쓸 때도 적용 경계와 결과가 보여야 한다.

## 2. 의미별 검사 → boolean 합성 → 분기·반환

조건식을 해석하기 전에 무엇을 판단하는지 읽고, debugger에서 각 검사 결과를 확인할 수 있어야 한다. 다음 순서를 기본형으로 사용한다.

1. 각 의미별 검사를 설명하는 boolean 변수로 만든다.
2. 최종 판단은 이름 붙인 검사 결과를 합성한 boolean 변수로 만든다.
3. `if`, 조건부 표현 또는 boolean 반환에서 그 판단 결과를 사용한다.

- 단순한 검사도 같은 방식을 따른다. 조건 길이나 비교 횟수로 변수화 여부를 매번 판단하지 않는다.
- 여러 검증 의미를 담은 긴 조건 전체에 `isInvalid` 같은 이름 하나만 붙이는 것으로 끝내지 않는다. 응답 형태, field 존재, type, 빈 값 등 개별 결과가 보여야 한다.
- 의미 하나가 여러 원시 조건을 필요로 할 수 있다. 예를 들어 null 여부와 object type은 함께 `isResponseObject`를 구성한다. 연산자 하나마다 변수를 만들지는 않는다.
- 이미 의미가 분명하고 nullish가 섞이지 않은 boolean 값은 그대로 사용한다. 같은 값을 다른 이름으로 다시 포장할 필요는 없다. `!`는 boolean의 부정 연산으로 사용할 수 있다.
- `is`, `has`, `can`, `should` 등 true의 의미를 드러내는 이름을 선택한다. 막연한 `check`, `verifyResponse`, `flag` 대신 대상과 판단을 적는다. 이름은 실제 검사보다 강한 보장을 암시하지 않는다.
- `sameSnapshot`처럼 함수 이름이 판단을 설명해도 내부의 각 비교를 이름 붙이고 합성한다. Boolean을 반환하는 검증 함수나 callback도 동일하다.

다음처럼 비교를 직접 연결하면 어느 검사에서 결과가 달라졌는지 따로 해석해야 한다.

```ts
function sameSnapshot(expected: Snapshot, actual: Snapshot): boolean {
  return expected.provider === actual.provider &&
    expected.version === actual.version &&
    expected.providerClientId === actual.providerClientId
}
```

아래는 getter나 side effect가 없는 읽기 전용 data의 같은 세 항목을 비교하는 작성 형태다. 실제 구현에 다른 비교 항목이 있으면 모두 보존하고, getter·외부 호출이 있으면 해당 평가의 실행 조건도 보존한다.

```ts
type Snapshot = Readonly<{
  provider: string
  version: string
  providerClientId: string
}>

function sameSnapshot(expected: Snapshot, actual: Snapshot): boolean {
  const hasSameProvider = expected.provider === actual.provider
  const hasSameVersion = expected.version === actual.version
  const hasSameProviderClientId =
    expected.providerClientId === actual.providerClientId

  const isSameSnapshot =
    hasSameProvider && hasSameVersion && hasSameProviderClientId

  return isSameSnapshot
}
```

### Nullish와 boolean 조건의 구분

- JavaScript/TypeScript에서 결측은 `value == null`, 존재는 `value != null`로 확인한다. 이 비교는 `null`과 `undefined`를 함께 다루려는 의도를 명시한다.
- Nonboolean 값의 `if (value)`, `!value`, `!!value`, `Boolean(value)`를 nullish 검사로 사용하지 않는다. `0`, `0n`, 빈 문자열, `false`, `NaN`의 유효성은 존재 여부와 별도로 판단한다.
- `== null` / `!= null`은 nullish 검사를 위한 의도적인 loose equality 사용이다. 일반 비교에는 `===` / `!==`를 사용하고, null만 또는 undefined만 구분하는 계약에도 해당 값과 strict 비교한다.
- Nullish가 섞이지 않은 boolean은 `if (isEnabled)`와 `!isEnabled`로 직접 읽을 수 있다. `boolean | null | undefined`는 `flag != null`의 존재 여부와 `flag === true` / `flag === false`의 값을 구분한다.
- Nullish 검사 결과도 앞의 명명·합성 기준을 따른다. `const hasValue = value != null` 또는 `const isValueMissing = value == null`로 의미를 드러내고 해당 boolean을 분기·합성에 사용한다.
- 존재와 내용 검사를 분리한다. 값이 존재한다는 사실만으로 문자열이 비어 있지 않거나 숫자가 유효한 범위라는 뜻은 아니다.
- 기존 truthiness 검사를 기계적으로 교체하지 않는다. 부재 거절과 존재 허용의 극성, 빈 값까지 거절하던 기존 의미를 확인하고 필요한 검사를 보존한다.

| 값 | `value == null` | `value != null` |
| --- | --- | --- |
| `null` | true | false |
| `undefined` | true | false |
| `0`, `0n` | false | true |
| `''` | false | true |
| `false` | false | true |
| `NaN` | false | true |

Nullable string의 존재와 빈 문자열을 구분하는 예시다. 빈 문자열을 허용하는 계약이라면 `hasText`만으로 존재를 판단한다.

```ts
function hasNonEmptyText(value: string | null | undefined): boolean {
  const hasText = value != null
  const isTextEmpty = hasText && value.length === 0
  const isTextNonEmpty = hasText && !isTextEmpty

  return isTextNonEmpty
}
```

## 3. 검사 의존성과 평가 시점을 보존

- 존재·type 확인 뒤에만 가능한 property 접근을 미리 실행하지 않는다. 앞선 검사 결과로 다음 평가를 보호한다.
- Short-circuit, 예외와 오류 우선순위, side effect의 실행 횟수·순서, getter, 시간 조회, lock과 취소 확인 시점을 유지한다. 모든 검사를 함수 시작에 미리 계산하지 않는다.
- 반복·재시도·상태 변경 이후에는 원래 조건이 평가되던 시점에 결과를 다시 계산한다. Fresh time 검사나 loop 조건을 한 번 계산한 boolean으로 고정하지 않는다.
- Type narrowing이 사라지면 안전하게 좁힌 값의 범위, 명시적 type predicate 또는 검증된 결과를 반환하는 경계를 사용한다. 이름을 붙이기 위해 근거 없는 `as`나 non-null assertion을 추가하지 않는다.
- 인증 값·원문 응답 등 수명을 제한해야 하는 값의 복사본이나 Promise 참조를 불필요하게 늘리지 않는다. 기존 참조 정리·노출 계약을 따른다.

다음은 JSON parsing 결과의 `id_token` field 형태를 검사하는 예시다. 검증된 object에서 field를 한 번 읽고, 해당 값의 type 확인 뒤에만 길이를 검사한다. JWT 내용이나 signature의 검증을 뜻하지 않는다.

```ts
function isInvalidTokenResponse(response: unknown): boolean {
  const isResponseObject =
    response != null && typeof response === 'object'

  const hasIdToken = isResponseObject && 'id_token' in response
  const idTokenField = hasIdToken ? response.id_token : undefined
  const isIdTokenString = typeof idTokenField === 'string'
  const isIdTokenEmpty = isIdTokenString && idTokenField.length === 0

  const isTokenResponseInvalid =
    !isResponseObject || !hasIdToken || !isIdTokenString || isIdTokenEmpty

  return isTokenResponseInvalid
}
```

최종 합성의 연산자도 의미에 맞아야 한다. 실패 조건 중 하나라도 해당하면 `||`로 거절하고, 필요한 성공 조건을 모두 만족해야 하면 `&&`로 결합한다. 이름 변경으로 true/false의 의미를 뒤집지 않는다.

## 4. 실패를 판단한 위치에서 오류 의미를 결정

- 직접 검증해 거절하는 지점에서 해당 module의 명시적인 오류를 던진다. 이유 없는 `new Error()`를 던지고 먼 catch가 의미를 추측하게 하지 않는다.
- 로그인 검증에서는 기존 `LoginFailure`와 오류 정의를 사용한다. 다른 module에 로그인 오류나 새 공통 Error framework를 강제하지 않는다. 기존 오류 계약에 맞는 type·code·고정 message로 실패 의미를 표현한다.
- TypeError는 실제 type 계약 위반에 사용할 수 있다. 만료·권한·상태 불일치 등 다른 실패를 일괄 TypeError로 바꾸지 않는다.
- 조건 이름에서 이유를 읽을 수 있고 외부 계약이 같으면 여러 검사에서 같은 오류 정의를 사용해도 된다. 검사마다 새 Error class나 외부 오류 코드를 만들 필요는 없다.
- 이미 분류된 module 오류는 catch에서 보존한다. 외부 library·DB·provider·IPC 예외는 그 호출을 책임지는 경계에서 기존 정책에 맞게 변환한다. 넓은 catch가 모든 실패를 같은 오류로 덮어쓰지 않게 한다.
- 예상한 외부 실패와 내부 버그를 임의로 같은 종류로 취급하지 않는다. 분류·응답이 달라져야 하면 [change-control](docs/rules/change-control.md)의 behavior 변경으로 다룬다.
- 명시적인 오류는 source에서 의미를 드러내는 기준이다. 기존 응답·log·IPC의 정제 계약을 유지하며 오류 분류를 이유로 원문 error object, credential, token, URL 또는 identity를 추가 노출·기록하지 않는다.

기존 로그인 오류 정의를 사용하는 분기 예시는 다음과 같다.

```ts
const isTokenResponseInvalid = isInvalidTokenResponse(response)

if (isTokenResponseInvalid) {
  throw new LoginFailure(LOGIN_ERRORS.PROVIDER)
}
```

### 정적 오류 catalog에서 타입 파생

- TypeScript에서 runtime으로 사용하는 정적 오류 목록은 catalog 한 곳에 정의한다. `as const`로 literal type을 유지하고 `satisfies`로 항목 형태를 검사한다. 이미 같은 역할의 형태 type이 있으면 재사용한다.
- 구체적인 오류 union은 `typeof CATALOG[keyof typeof CATALOG]`로 파생하고 Error class의 field 타입도 그 정의에서 가져온다. Code·status·message의 구체 목록을 별도 union이나 interface에 중복 작성하지 않는다.
- 호출부는 catalog 항목을 선택해 해당 module의 Error class에 전달한다. 새 오류는 기존 계약과 변경 절차에 따라 catalog에 추가하며 호출부에서 임의의 정의를 만들지 않는다. 공통 catalog를 spread할 때 원본 literal type과 key 중복·덮어쓰기 의도를 확인한다.
- 아래 code·status·message는 로그인 오류의 예시다. Catalog의 필드는 각 module의 기존 오류 계약에 맞추며 모든 오류에 HTTP status나 새 공통 Error framework를 강제하지 않는다.
- `as const`와 `satisfies`는 compile-time 표현이다. Runtime validation이나 객체 동결을 대신하지 않는다. `stack`·`cause`의 보존·정제는 기존 진단·노출 계약을 따른다.

```ts
type ErrorDefinitionShape = Readonly<{
  code: string
  status: number
  message: string
}>

export const REFRESH_ERRORS = {
  AUTHENTICATION_REQUIRED: {
    code: 'AUTHENTICATION_REQUIRED',
    status: 401,
    message: '로그인이 필요합니다.',
  },
} as const satisfies Record<string, ErrorDefinitionShape>

type RefreshErrorDefinition =
  typeof REFRESH_ERRORS[keyof typeof REFRESH_ERRORS]

export class RefreshFailure extends Error {
  readonly code: RefreshErrorDefinition['code']
  readonly status: RefreshErrorDefinition['status']

  constructor(definition: RefreshErrorDefinition) {
    super(definition.message)
    this.name = 'RefreshFailure'
    this.code = definition.code
    this.status = definition.status
  }
}

throw new RefreshFailure(REFRESH_ERRORS.AUTHENTICATION_REQUIRED)
```

## 5. 이름·표현·함수 경계

- 여러 request, code, token, 설정, 결과가 함께 있으면 실제 역할이 구분되는 이름을 사용한다. 시간은 어떤 사건이나 검사 시점인지 나타낸다. 생성 시각과 생성 후 재검사 시각을 혼용하지 않는다.
- 짧은 범위에서 의미가 하나로 명확한 `row`, `result`, `now`는 사용할 수 있다. 단계 경계를 넘는 축약 때문에 선언 위치를 반복해서 찾게 하지 않는다.
- 역할이 다른 변수의 다중 선언, 여러 side effect가 있는 분기, 여러 동작을 담은 try/catch를 한 줄에 압축하지 않는다. 호출 인자·객체 field도 의미 단위로 펼친다.
- 응집된 작은 객체와 읽는 순서가 명확한 method chain을 금지하지 않는다. 특정 줄 수나 글자 수를 가독성의 합격 기준으로 삼지 않는다.
- Helper는 실제 작업이나 검증을 맡고 이름·입력·결과가 책임을 설명해야 한다. 단계가 명확해지면 재사용되지 않아도 분리할 수 있다. Shared abstraction의 조건은 해당 app의 Rule을 함께 따른다.
- 호출을 그대로 전달하는 wrapper, 함수 길이만 줄이는 이동, 필요 없는 layer·class·DTO를 추가하지 않는다. 검증된 기존 module/library의 계약을 재사용한다.
- Non-null assertion과 type assertion의 근거는 근처 검사, 상태 type, DB constraint 또는 명시된 함수 계약에서 확인할 수 있어야 한다.
- 검증된 상태를 type으로 표현해 추적 부담을 줄일 수 있는지 검토한다. 복잡한 generic 체계나 무조건적인 중복 검사를 도입하지 않는다. 서로 다른 trust boundary의 필요한 runtime validation은 유지한다.

## 6. 주석과 동작 보존

- 주석은 lock 뒤 시간 재확인, 외부 호출 중 잠금 해제, commit 후 결과 반환처럼 code만으로 드러나지 않는 이유·보존 조건을 가까이에 설명한다.
- 이름과 값의 실제 시점이 다르면 이름을 수정한다. Code를 번역하는 주석, 모든 함수의 형식적인 단계 번호, canonical contract의 긴 복제는 피한다. 상세 정책은 해당 file path를 참조한다.
- 가독성 변경에서도 오류 우선순위, 상태 전이, DB 쓰기, lock·fresh time, 외부 호출, rollback·cleanup과 결과 전달 순서를 보존한다. 반복처럼 보이는 검사도 contract에서 맡는 역할을 확인한다.
- 동작을 바꿔야 하면 가독성 수정에 숨기지 않고 [change-control](docs/rules/change-control.md)과 [testing](docs/rules/testing.md)의 절차를 따른다.
- Formatting과 제어 흐름 변경을 검토 가능한 commit으로 구분한다. Test assertion이나 경합 관측을 약화하지 않는다. 단순 formatting에 test를 기계적으로 추가하지 않고 변경 종류에 맞는 동등성·validation evidence를 남긴다.

## Review에서 확인할 것

1. 처리 단계와 각 분기의 이유를 이름만으로 먼저 설명할 수 있는가?
2. 개별 검사 결과를 debugger에서 볼 수 있고 최종 boolean이 그 결과들로 합성되는가?
3. 단순 조건·검증 함수 내부·test라는 이유로 기준을 생략하지 않았는가?
4. 실패를 판단한 위치가 적절한 오류를 선택하고 이미 분류된 오류가 보존되는가?
5. 정적 오류의 runtime 정의·형태 검사·구체 타입이 연결되고 호출부가 catalog 항목을 선택하는가?
6. Nullish 존재 여부와 boolean·빈 값·내용 검사를 구분하고 nonboolean truthiness를 피했는가?
7. Property 접근·type narrowing·평가 시점·side effect·민감 값 수명이 보존되는가?
8. Helper와 주석이 책임·이유를 드러내며 불필요한 이동이나 중복 설명을 늘리지 않는가?

기준을 충족하지 못하면 위치·이유·더 작은 개선안을 review에 남긴다. 문법·library 계약에 따른 제한은 구체적인 근거로 기록한다. 별도의 승인 단계를 추가하지 않으며 변경 절차와 logic/context budget은 기존 Rule을 따른다.

승인 전 세부 기준의 의미와 예외는 별도 문서의 [제안 검토 항목](docs/rules/code-expression.md#제안-검토-항목)으로 검토한다. 기존 코드 review의 새 의무로 적용하지 않는다.

## 근거와 관련 Rule

- [Code Quality](docs/rules/code-quality.md): 유지보수성, logic/context budget과 Rule lifecycle.
- [Change Control](docs/rules/change-control.md), [Testing](docs/rules/testing.md): 승인·scope·commit과 변경별 validation.
- [PR #59](https://github.com/blahaj94/ldb/pull/59), `b695ac3`: `apps/api/src/auth/access-jwt/index.ts`의 입력 확인·만료 계산·서명·결과 경계.
- [PR #64](https://github.com/blahaj94/ldb/pull/64), `a613912`: `apps/api/src/auth/login/exchange.ts`, `apps/api/src/auth/login/callback.ts`, `apps/api/src/auth/login/start.ts`의 상태 변경·commit 이후 결과·lock/TTL 검사.
- [PR #71 오류 리뷰](https://github.com/blahaj94/ldb/pull/71#discussion_r3943229966), [조건식 리뷰](https://github.com/blahaj94/ldb/pull/71#discussion_r3943233619)와 후속 인터뷰: 의미별 boolean·최종 합성·오류 책임·프로젝트 전체 적용.

사례는 표현을 설명하며 해당 구현의 전체 승인이나 merge를 대신하지 않는다. 함수 길이·단계 번호·file 수·Result type 개수는 목표가 아니다. 적용 후 실제 수정 지점과 실패 이유를 찾기 쉬워졌는지, 불필요한 길이·주석·이동이 늘지는 않았는지 재검토한다.
