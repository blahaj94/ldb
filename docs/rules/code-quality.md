---
type: rule
status: active
enforcement: warning
scope: repository
last-reviewed: 2026-08-28
---

# Code Quality

## Goal

AI가 빠르게 생성한 code도 사람이 다시 읽고 수정할 수 있어야 하며, 다음 AI가 전체 repository를 context로 읽지 않고도 변경할 수 있어야 한다.

## Logic budget

하나의 commit에서 새로 작성하거나 실질적으로 변경하는 logic은 약 300줄을 soft budget으로 사용한다. 숫자는 hard block이 아니며 semantic change 규모를 조기에 드러내기 위한 warning 기준이다.

Logic에 포함한다.

- domain과 business rule
- state transition
- validation, authentication, authorization
- 조건 분기와 control flow
- data transformation
- side effect orchestration
- React hook, state store, service 내부 동작

기본적으로 제외한다.

- test, mock, fixture, snapshot
- generated file
- JSX와 HTML markup
- CSS와 정적인 style 선언
- 단순 static data

SQL, migration, 복잡한 config, route definition처럼 경계가 애매한 변경은 AI가 임의로 제외하지 않고 PR에서 별도로 보고한다.

Test·mock의 logic 줄 수 제외는 전체 작업 비용에서 제외한다는 뜻이 아니다. 범용 기능의 자체 구현으로 규모가 커지면 commit 분리를 제안하기 전에 [`Dependency 선택과 비용`](change-control.md#dependency-선택과-비용)에 따라 library 등으로 줄일 수 있는 범위와 남는 제품 정책을 검토한다. 이때 test·mock·review·유지보수 비용도 포함한다.

Logic budget을 넘으면 AI는 구현을 숨기거나 기계적으로 줄 수를 맞추지 않는다. 다음을 preflight 또는 PR에 보고하고 분리를 제안한다.

```text
현재 logic diff 규모
커진 이유
분리 가능한 단위
분리 시 trade-off
권장 분리안
```

작업 분리 여부는 사용자가 결정한다.

## Maintainability

- Module은 설명 가능한 하나의 책임을 가진다.
- 실제 사용 사례가 없는 speculative abstraction을 만들지 않는다.
- 공통 로직의 재사용, wrapper와 모듈 분리는 [코드 재사용과 공통 패키지 분리 기준](code-reuse.md)을 따릅니다. 불필요한 indirection은 피합니다.
- 기존 pattern과 다른 새 pattern을 도입하려면 이유와 영향을 설명한다.
- Feature와 unrelated refactoring을 같은 Issue에 섞지 않는다.
- Core behavior는 test와 분리되어 추론 가능해야 한다.
- 큰 mock, fixture, generated file이 logic review를 가리지 않도록 분리한다.
- Source 위치는 file path로 참조하며 line number를 durable context로 저장하지 않는다.

## Context budget

- [`docs/README.md`](../README.md#역할별-시작점)의 역할별 route에서 시작해 task에 필요한 document와 module만 읽는다. 동일 revision의 재확인 조건은 [`AGENTS.md`](../../AGENTS.md#context)를 따른다.
- 처음에는 file 목록·제목·검색 결과로 대상을 좁히고 필요한 file 본문이나 절을 읽는다. Rule 적용 여부가 불명확하면 본문을 확인하며 목록·제목만으로 지침을 파악했다고 간주하지 않는다.
- 검색은 `rg --files` 또는 `rg`에 대상 path·glob·pattern을 지정한다. 검색 결과 수와 tool의 최대 출력량을 제한하고, truncation이 발생하면 생략된 부분을 추정하지 않고 범위·절을 좁혀 다시 조회한다.
- 기존 file·tool 출력·code walkthrough를 Markdown이나 다른 전달물에 복제하지 않고 필요한 결론과 boundary, invariant, contract, command 및 정확한 pointer를 기록한다.
- 긴 대화·원 대화와 raw log를 새 Worker에게 전달하지 않는 방법은 [`Handoff와 context`](agent-execution.md#handoff와-context)를 따른다.
- 같은 설명을 여러 file에 중복하지 않고 canonical document를 link한다.
- `AGENTS.md` 약 150줄, 개별 Rule document 약 250줄을 soft budget으로 사용한다.
- Budget을 넘으면 topic별로 분리하고 `docs/README.md`에서 routing한다.

## Experimental Rule lifecycle

가독성과 context 효율 Rule은 실제 작업에서 검증하며 고도화할 수 있다. 새로운 Rule 제안에는 다음 정보를 포함한다.

```yaml
status: proposed | active | deprecated
enforcement: warning | approval-required | blocking
rationale: Rule이 필요한 이유
evidence: 해결하려는 실제 문제
exceptions: 예외 조건
review-after: 재검토 시점 또는 조건
```

AI는 실험과 변경을 PR에 제안할 수 있다. PR scope가 proposed Rule의 substantive contract와 `active` 전환을 채택 대상으로 명시하고 사용자가 merge하면 그 Rule이 `active`가 된다. 절차 문구·link·표현만 수정한 merge는 기존 proposed status를 바꾸지 않는다. Merge 전에는 해당 PR의 구현·검증 범위 밖에서 active Rule로 사용하지 않는다.
