---
type: rule
status: active
enforcement: warning
scope: backend server source and related tests
last-reviewed: 2026-09-06
rationale: 사람이 Backend code의 처리 순서와 결과를 이해하기 위해 추가로 해야 하는 해석·추적 부담을 줄인다.
evidence: "PR #59와 PR #64의 가독성 비교 및 PR #64 a613912의 사용자 검토"
exceptions: 아래 적용 범위와 예외에 따르며 기존 behavior·security contract와 library 계약을 우선한다.
review-after: 승인 뒤 Backend 구현 PR 3개에서 사람이 읽고 수정하는 경험을 검토한 시점
---

# Backend Readability

## 목표와 적용 범위

독자가 처리 순서, 판단 근거, 상태 변경과 실패 결과를 code에서 직접 따라갈 수 있게 작성한다. 이를 위해 필요한 명시성과 길이를 허용한다.

적용 대상은 `apps/api`와 향후 서버용 app/package의 source 및 직접 관련된 test다. 사람의 재진입 기준은 TypeScript와 async/await를 이해하고 관련 contract를 읽은 유지보수자다. 특정 module의 내부 관례를 이미 외웠다고 가정하지 않는다.

이 문서는 [`code-quality.md`](code-quality.md)의 유지보수성 기준을 Backend 작업에 구체화한다. 승인·scope·dependency는 [`change-control.md`](change-control.md), 검증은 [`testing.md`](testing.md)를 따른다. 이 Rule은 [PR #66의 사용자 승인](https://github.com/blahaj94/ldb/pull/66#issuecomment-5557123897)을 반영한다.

## 작성 제약

### 1. 처리 순서가 보이는 주 흐름

- 진입 함수에서 입력 확인, 주요 처리 단계, 외부 호출, DB 변경과 결과 반환을 찾을 수 있게 작성한다. 해당 작업에 없는 단계를 형식적으로 추가하지 않는다.
- 여러 단계가 있는 함수는 빈 줄과 의미 있는 이름으로 구분한다. 단계 번호·주석은 순서의 의미를 설명할 때 사용한다.
- Test도 준비·실행·검증의 흐름을 따라갈 수 있게 배치한다.
- Transaction과 실패 결과를 함께 보여 주는 긴 함수는 길이만으로 분리하지 않는다. 분리할 때는 하나의 실제 작업을 맡는 helper로 나눈다.

### 2. 상태 변경과 실패 결과를 명시

- 호출부에서 어떤 상태를 바꾸는지, 실패할 때 무엇이 남는지 구분할 수 있어야 한다.
- 같은 Error를 `return`하거나 `throw`하는 차이, 선택 인자의 유무 같은 내부 관례에 서로 다른 commit/rollback 정책이나 상태 전이를 숨기지 않는다.
- 실패 정리를 commit한 뒤 거절하는 경우와 전체 쓰기를 rollback하는 경우를 이름, 명시적 결과 type 또는 직접적인 제어 흐름으로 구분한다.
- 결과를 어느 transaction 경계 이후에 전달하는지 드러낸다. Helper 내부에 있는 DB 변경·외부 호출·cleanup도 호출자가 예상할 수 있어야 한다.
- Result union은 가능한 표현 수단이다. 모든 함수에 Result type을 추가하거나 공통 transaction framework를 만들 의무는 없다. Library 고유의 관례를 사용하는 경우에도 적용 경계와 결과가 드러나야 한다.

### 3. 역할과 시점이 정확한 이름

- 여러 종류의 request, code, token, 설정 또는 결과가 함께 등장하면 실제 역할을 구분하는 이름을 사용한다.
- 시간 변수는 어떤 사건이나 검사 시점인지 정확히 나타낸다. 실제 생성 시각과 생성 후 재검사 시각을 같은 이름으로 표현하지 않는다.
- 값이 단계 경계를 넘어 사용된다면 이름만으로 대상을 다시 찾을 수 있게 한다. 읽는 사람이 선언 위치를 반복해서 찾아가야 하는 축약을 피한다.
- `row`, `result`, `now`를 일괄 금지하지 않는다. 짧은 범위에서 의미가 하나로 명확하다면 사용할 수 있다.

### 4. 여러 동작을 한 줄에 압축하지 않기

- 역할이 다른 변수의 다중 선언, 여러 side effect가 있는 분기, 여러 동작을 담은 `try/catch`를 한 줄에 압축하지 않는다.
- 호출 인자·객체 field·검증 조건을 한 번에 해석하기 어렵다면 의미 단위로 펼쳐 쓴다. 코드 줄 수를 줄이기 위해 다시 합치지 않는다.
- 서로 다른 검증 이유가 섞여 있다면 조건을 나누거나 목적을 나타내는 이름을 붙인다. Short-circuit와 오류 우선순위는 보존한다.
- 긴 조건식 자체, 응집된 작은 객체, 단순 guard, 읽는 순서가 명확한 method chain은 금지하지 않는다. 특정 줄 수나 글자 수를 가독성의 합격 기준으로 삼지 않는다.

### 5. 책임과 검증 근거가 가까운 경계

- Helper는 의미 있는 작업이나 검증을 맡고, 이름과 입력·결과가 그 책임을 설명해야 한다. 실제 단계가 명확해진다면 재사용되지 않아도 분리할 수 있다.
- 호출을 그대로 전달하기만 하는 wrapper, 함수 길이만 줄이기 위한 이동, 필요가 없는 layer·class·DTO를 추가하지 않는다. 기존 검증된 module/library의 계약을 활용한다.
- `!`와 type assertion을 사용할 때는 근처의 검사, 상태 type, DB constraint 또는 명시된 함수 계약에서 근거를 확인할 수 있어야 한다. 필요한 근거가 없다면 단언으로 통과시키지 않는다.
- 검증된 상태를 다음 단계의 type으로 표현하면 추적 부담이 줄어드는지 검토한다. 이를 위해 복잡한 generic 체계를 만들거나 같은 검사를 무조건 추가하지 않는다.
- 서로 다른 입력·신뢰 경계에서 필요한 검증은 유지한다. 중복처럼 보인다는 이유만으로 HTTP 경계나 직접 호출 가능한 service의 검증을 제거하지 않는다.

### 6. 주석은 이유와 보존 조건을 설명

- Lock 뒤 시간을 다시 읽는 이유, 외부 호출 중 잠금을 놓는 이유, 결과를 commit 뒤 전달하는 이유처럼 code만으로 드러나지 않는 판단을 가까이에 설명한다.
- 변수명이 가리키는 시점과 실제 값이 다르면 주석으로 정당화하지 말고 이름을 수정한다.
- 단순한 code의 번역, 모든 함수에 붙이는 형식적인 단계 설명, canonical contract의 긴 복제는 피한다. 상세 정책은 해당 Rule의 file path로 참조한다.

### 7. 가독성 변경에서도 동작을 보존

- 오류 우선순위, 상태 전이, DB 쓰기, lock과 fresh time 조회, 외부 호출, rollback과 cleanup의 순서를 보존한다. 반복처럼 보이는 검사도 해당 contract의 역할을 먼저 확인한다.
- 동작을 바꿀 필요가 생기면 가독성 수정에 숨기지 않고 기존 change-control/testing 절차의 behavior 변경으로 다룬다.
- Formatting과 제어 흐름 변경을 구분해 검토 가능한 commit으로 정리한다. Test의 assertion이나 경합 관측을 약화해서 refactor를 통과시키지 않는다.
- 단순 formatting에 새 test를 기계적으로 추가하지 않는다. 변경 종류에 맞는 동등성 확인과 관련 검증은 기존 testing Rule을 따른다.

## 기존 review에서 확인할 질문

1. 진입 함수와 직접 이름 붙인 helper를 읽고 처리 순서를 설명할 수 있는가?
2. 이 분기에서 실패하면 DB와 외부 시스템에 어떤 변경이 남는지 찾을 수 있는가?
3. 이 값이 유효하다고 판단하는 근거와 이 시간이 가리키는 시점을 가까이에서 확인할 수 있는가?
4. 함수·file 분리가 실제 책임을 드러내는가? 같은 흐름을 이해하기 위한 이동만 늘리지는 않았는가?
5. 줄 수나 문법을 단순하게 보이게 만들기 위해 중요한 검증·부수효과를 숨기지는 않았는가?

기준을 충분히 만족하지 못하는 경우에는 어려운 위치와 이유, 더 작은 개선안을 review에 남긴다. 타당한 예외는 가까운 주석이나 PR 설명에 짧게 기록하며, 이 문서만으로 새로운 승인 단계를 추가하지 않는다.

## 참고 사례와 한계

| 사례 | Source | 참고할 표현 |
| --- | --- | --- |
| [PR #59](https://github.com/blahaj94/ldb/pull/59), `b695ac3` | `apps/api/src/auth/access-jwt/index.ts` | 입력 확인→만료 계산→서명→결과 반환을 따라 읽을 수 있고, `!`의 근거가 사용 위치 가까이에 있다. |
| [PR #64](https://github.com/blahaj94/ldb/pull/64), `a613912` | `apps/api/src/auth/login/exchange.ts`, `apps/api/src/auth/login/callback.ts`, `apps/api/src/auth/login/start.ts` | 처리 단계·상태 변경·commit 이후 결과가 명시되어 있고, 필요한 lock·TTL 재검사를 유지한다. |

이 사례의 모든 표현을 그대로 복제하지 않는다. 함수 길이, 단계 번호, file 수, Result type 개수는 목표가 아니다. PR #64의 가독성 평가는 구현 전체의 승인이나 merge를 대신하지 않는다.

재검토할 때는 후속 Backend PR에서 사람이 실제 변경 지점을 찾고 실패 결과를 설명할 수 있었는지 확인한다. 불필요한 길이·주석·이동이 늘어난 제약은 근거와 함께 조정한다. 이 Rule의 변경 승인은 기존 change-control을 따른다.
