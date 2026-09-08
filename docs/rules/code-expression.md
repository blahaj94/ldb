---
type: rule
status: active
enforcement: warning
scope: repository handwritten source, tests, scripts and tooling
last-reviewed: 2026-09-08
rationale: 처리 단계와 문자열 생성, 분기, 호출 입력의 역할을 사람이 한 번에 읽을 수 있도록 공통 컨벤션의 경계를 구체화한다.
evidence: "Issue #145: https://github.com/blahaj94/ldb/issues/145 — apps/api/src/database/generate.ts의 generateMigration 가독성 논의; PR #146 사용자 승인·merge: https://github.com/blahaj94/ldb/pull/146#issuecomment-5579597615"
exceptions: 단순 문자열 삽입·호출과 명확한 단일 인자를 허용하며 외부 API signature, 평가 시점, 오류·cleanup과 민감 값 수명은 기존 계약을 유지한다.
review-after: 승인 후 서로 다른 app 또는 tooling의 코드 PR 3개에서 단계·입력의 역할을 읽기 쉬워졌는지와 불필요한 변수·함수 분리가 늘었는지 검토한다.
---

# 코드 표현과 함수 입력 가독성

## 상태와 적용 범위

이 문서는 [Issue #145](https://github.com/blahaj94/ldb/issues/145)의 여섯 기준에 대한 [PR #146의 사용자 승인](https://github.com/blahaj94/ldb/pull/146#issuecomment-5579597615)과 merge를 반영한 active Rule이다. 이후 변경은 [Change Control](change-control.md#approval-evidence)을 따른다.

기존 active Rule인 [`convention.md`](../../convention.md#적용-범위와-권한)의 적용 범위와 권한을 유지한다. 아래 기준은 처리 순서와 이름·표현·함수 경계를 구체화하며, 기존 규칙을 대체하거나 기존 코드를 일괄 정리하라는 지시가 아니다.

예시는 표현을 설명한다. 실제 migration 형식이나 제품 오류 정책을 정하지 않는다. 평가의 실행 조건·순서·횟수와 오류 우선순위, cleanup 및 민감 값 수명은 [`convention.md`의 평가 시점](../../convention.md#3-검사-의존성과-평가-시점을-보존)과 [동작 보존](../../convention.md#6-주석과-동작-보존)을 따른다. 변수를 앞으로 옮겨 원래 실행되지 않던 호출까지 실행하지 않는다.

## 1. 같은 작업은 묶고 다음 단계에서 빈 줄을 넣는다

같은 작업에 속한 문장은 붙여 쓰고 입력 확인, 값 준비, 외부 호출, 결과 반환처럼 다음 처리 단계로 넘어갈 때 빈 줄을 넣는다. 문장마다 빈 줄을 넣거나 작업에 없는 단계를 형식적으로 만들지 않는다.

```ts
const className = createMigrationClassName(timestamp)
const source = renderMigrationSource({ className, upQueries, downQueries })

await writeMigrationFile({ filePath, source })

return filePath
```

## 2. 여러 줄 문자열에 이름을 붙이고 독립적인 생성은 함수로 분리한다

두 줄 이상의 문자열은 `return`이나 호출 인자에 바로 넣지 않고 역할을 설명하는 변수에 담는다. 독립적인 템플릿 생성 작업은 재사용 여부와 관계없이 이름 있는 함수로 분리한다. 변수로 결과의 의미를, 함수로 생성 책임을 드러낸다.

여러 줄 string literal은 변수 선언의 `=`까지 한 줄에 쓰고, 여는 백틱은 다음 줄의 첫 칸에서 시작한다. 첫 내용은 여는 백틱 바로 뒤에 두며, 문자열 내부의 기존 내용·개행·들여쓰기는 유지한다. 짧은 단일 줄 문자열은 같은 줄에 둘 수 있다.

```ts
type MigrationSourceInput = {
  className: string
  upQueries: string[]
  downQueries: string[]
}

function renderMigrationSource({
  className,
  upQueries,
  downQueries,
}: MigrationSourceInput): string {
  const upBody = upQueries.join('\n')
  const downBody = downQueries.join('\n')

  const source =
`export class ${className} {
  async up() {
${upBody}
  }
  async down() {
${downBody}
  }
}`

  return source
}

const source = renderMigrationSource({ className, upQueries, downQueries })
```

호출을 그대로 전달하는 wrapper나 함수 길이만 줄이는 이동은 기존 [함수 경계 기준](../../convention.md#5-이름표현함수-경계)을 따른다. 외부 library가 template이나 callback 형태를 정한 경우에는 그 계약을 보존한다.

## 3. 문자열 안에는 단순한 삽입을 남긴다

문자열 내부에 분기나 여러 변환이 중첩되면 해당 표현을 문자열 생성 앞에서 계산하고 이름을 붙인다. 단순한 값 삽입이나 단순 호출은 그대로 허용한다. 조건식 자체의 명명·합성은 기존 [의미별 검사 기준](../../convention.md#2-의미별-검사--boolean-합성--분기반환)을 따른다.

```ts
const queryBody = queries
  .map(renderQuery)
  .join('\n')
const body = hasQueries ? queryBody : '// No queries'

const source =
`async up() {
${body}
}`
```

위 예시는 `hasQueries`가 이미 의미가 명확한 boolean이고 `renderQuery`가 순수한 변환인 경우다. 기존 코드에서 분기 안에서만 수행하던 변환이라면 그 분기 안에 계산을 둔다.

다음 단순 표현은 허용한다.

```ts
const fileName = `${className}.ts`
const heading = `Migration: ${formatTimestamp(timestamp)}`
```

## 4. 짧은 분기도 중괄호와 줄바꿈으로 드러낸다

짧은 `return`·`throw`도 중괄호와 줄바꿈을 사용한다. `try/catch`도 한 줄로 압축하지 않는다. 분기를 없애거나 오류 처리 정책을 새로 정하는 기준은 아니다.

```ts
if (isComplete) {
  return result
}

if (isInputInvalid) {
  throw new TypeError('Expected migration input')
}

try {
  await writeMigrationFile({ filePath, source })
} catch (error) {
  await cleanupTemporaryFile(filePath)
  throw error
}
```

예시의 `isInputInvalid`는 type 계약 위반을 뜻한다. 실제 코드에는 기존 module 오류와 cleanup 정책을 유지하며, 이 예시를 이유로 새 catch나 cleanup을 추가하지 않는다.

## 5. 두 번 이상 이어지는 메서드 호출은 호출마다 줄을 나눈다

메서드 호출이 두 번 이상 이어지면 각 호출을 새 줄에 쓴다. 속성 접근은 해당 대상에 붙여 두며 속성마다 줄을 나누지 않는다. 체인 자체는 계속 허용한다.

```ts
const queryBody = migration.upQueries
  .map(renderQuery)
  .join('\n')

const queryCount = migration.upQueries.length
```

## 6. 여러 값의 역할이나 순서가 불명확하면 객체 인자로 받는다

호출과 선언에서 여러 값의 역할이나 순서가 불명확하면 이름 있는 객체 field로 전달하고 받는다. 예를 들어 `renderMigrationSource(className, upQueries, downQueries)`의 배열 두 개는 순서만으로 역할을 구분해야 하므로 [문자열 생성 예시](#2-여러-줄-문자열에-이름을-붙이고-독립적인-생성은-함수로-분리한다)처럼 선언하고 호출한다.

```ts
const source = renderMigrationSource({ className, upQueries, downQueries })

validateNickname(nickname)
```

`validateNickname(nickname)`처럼 함수 이름과 단일 인자만으로 역할이 명확하면 그대로 허용한다. 모든 함수를 객체 인자로 바꾸는 기준이 아니다. 외부 API·library가 정한 signature와 callback 인자 순서는 유지한다.

## 검토 항목

- 같은 작업을 묶고 다음 처리 단계에서 빈 줄로 구분했는가?
- 두 줄 이상의 문자열에 이름을 붙이고 여는 백틱과 첫 내용을 `=` 다음 줄의 첫 칸에서 시작하며 문자열 내부를 보존했는가? 독립적인 템플릿 생성 책임을 함수로 드러냈는가?
- 문자열 내부의 중첩 분기·변환을 분리하면서 단순 삽입·호출은 허용했는가?
- 짧은 `return`·`throw`와 `try/catch`를 중괄호·줄바꿈으로 읽을 수 있는가?
- 두 번 이상 이어지는 메서드 호출을 줄로 구분하고 속성 접근은 붙여 두었는가?
- 여러 입력의 역할을 객체 field로 드러내면서 명확한 단일 인자와 외부 signature를 유지했는가?

위 항목은 [`convention.md`의 검토 기준](../../convention.md#review에서-확인할-것)과 함께 적용하며 각 기준의 예외와 동작 보존 조건을 유지한다.

formatter 적용 범위에서 순수한 줄 배치가 이 문서의 수동 예시와 충돌하면 proposed [`convention-tooling.md`](convention-tooling.md)의 승인된 Prettier 출력 우선 기준을 따른다. 이는 §2의 문자열 위치와 §5의 method chain 배치를 formatter 출력에 맞추는 기준이며, 의미별 빈 줄·문자열 내용·생성 책임·평가 시점과 함수 입력 의미를 바꾸는 권한이 아니다.
