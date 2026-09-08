---
type: rule
status: active
enforcement: approval-required
scope: repository
last-reviewed: 2026-09-08
rationale: 이미 의미가 분명한 순회와 독립적인 순수 검사를 과하게 분해하지 않으면서 기존 가독성과 동작 보존 경계를 유지한다.
evidence: "https://github.com/blahaj94/ldb/pull/159#discussion_r3955937537; https://github.com/blahaj94/ldb/pull/159#discussion_r3955954135; https://github.com/blahaj94/ldb/pull/161#issuecomment-5582698349"
exceptions: 승인 전에는 기존 convention과 convention-migration 기준을 적용하며, 이 문서의 조건을 벗어난 callback·검사·평가 시점 변경에는 적용하지 않는다.
review-after: 사용자 승인·merge 후 서로 다른 code review 또는 migration PR 3건에서 적용 조건·동등성·검토 부담을 확인한다.
---

# Convention Exceptions Proposal

이 문서는 `convention.md`의 의미별 boolean 분해와 평가 시점 보존에 대한 두 가지 좁은 예외를 정의한다. 두 예외는 같은 승인·적용 lifecycle을 공유하지만 서로 다른 조건을 가진다. PR #161의 사용자 명시 승인과 merge로 이 문서는 active가 되었으며, 아래 조건을 충족하는 범위에서만 적용한다.

## 공통 경계

`some`, `find`, `filter`라는 이름만으로 callback 전체를 면제하지 않는다. 연산과 입력의 역할, 함수의 단일 선택·일치 목적이 짧고 응집된 표현만으로 분명할 때만 직접 표현하거나 결과를 바로 반환할 수 있다. 복합 판정·validation은 면제하지 않는다. 단순한 글자 수나 비교 수는 근거가 아니다. 순회나 table을 배열 index별 분기로 바꾸지 않는다.

두 예외 모두 반환값, 오류·schema·보안 정책, 논리의 극성, 필요한 type·존재 보호를 유지한다. 단순함은 순수성을 증명하지 않는다. TypeScript `readonly`만으로 getter나 Proxy가 없다고 판단하지 않는다. 변경 가능한 외부 상태나 관찰 가능한 객체 동작, getter, Proxy, 사용자 정의 coercion, 시계·난수·I/O·상태 변경·async, 실패와 예외 우선순위가 있거나 불확실하면 기존 기준을 적용한다. 확보된 고정 primitive 입력값인 `filename`은 예시처럼 사용할 수 있다.

## 예외 A: 응집된 순회·검색 선택

순회·검색 연산과 단일 조건이 하나의 선택·일치 의미를 직접 드러내면 boolean을 callback 내부의 여러 이름으로 나누지 않을 수 있다. 허용 예시는 다음과 같다.

```ts
const isRuleFile = RULE_PATHS.some((path) =>
  path.endsWith('/') ? filename.startsWith(path) : filename === path,
)
```

이 예시는 `RULE_PATHS`를 순회하고 각 path가 directory prefix 또는 exact filename인지 선택한다는 의도가 표현 자체에 드러난다. 복합 validation, domain 권한, type guard, 부작용, 여러 처리 단계가 callback에 들어가면 기본 명명·합성 기준을 유지한다. 변경 가능한 외부 상태를 읽거나 바꾸거나 예외를 분류하면 이 예외를 사용하지 않는다.

## 예외 B: 독립 순수 검사의 평가 분리

기존 short-circuit 앞 guard가 뒤 검사를 보호하지 않고, 두 검사가 입력 type·값이 확정된 뒤 수행되는 독립 순수 검사라면 각 boolean을 따로 계산하고 최종 boolean으로 합성할 수 있다. 예시는 문자열 입력과 `g`·`y` 없는 정규식, 각 검사의 순수성을 확인한 경우를 전제로 한다.

```ts
const hasLogicExtension = LOGIC_EXTENSION.test(filename)
const isNonLogicPath = NON_LOGIC_PATH.test(filename)
const isLogicFile = hasLogicExtension && !isNonLogicPath
```

이 예외의 근거는 실제 정규식 정의가 현재 `i` flag만 사용하고 `g`·`y`가 없으며, `filename`이 문자열이고 두 검사가 순수하다는 확인이다. 원래 앞 검사가 false여서 뒤 검사가 실행되지 않던 입력에서도 뒤 검사를 실행해도 안전하고, 결과·오류·관찰 가능한 상태·업무 비용 제한이 변하지 않는다는 근거가 모두 있어야 한다. 평가 횟수 완화는 이처럼 독립 순수 검사에만 허용한다.

상태를 가진 정규식, getter가 있는 filename, custom coercion, 시간·난수·I/O·상태·async 또는 예외 우선순위가 있는 검사는 제외한다. type·존재 확인에 의존하는 property 접근을 앞당기지 않는다. 순수성이나 오류 동등성을 확인할 수 없으면 기존 short-circuit와 평가 시점을 보존한다.

## 적용 순서와 lifecycle

현재 `convention.md` §2·§3과 review checklist, [`convention-migration.md`](convention-migration.md)의 추가 호출 금지·동작 보존 기준이 기본이다. 이 문서는 그 기준을 삭제하거나 전역 완화하지 않는다. 승인된 Rule이 merge된 뒤에도 예외 A 또는 B의 개별 조건과 근거를 충족하는 경우에만 적용한다. 기존 #158의 retry 소진과 model 판단은 자동으로 해제하지 않는다.

코드 예시는 설명용이며 제품 선택이나 새 정책을 정의하지 않는다. 이 예외가 허용하는 순수 검사 범위 밖이거나 추가 평가의 안전성, 결과·오류 동등성 근거가 불확실하면 해당 범위를 보류하고 기존 change-control·testing 절차와 사람 판단을 따른다. getter·Proxy 관찰, 오류 우선순위 또는 상태 결과의 차이는 계속 금지한다.
