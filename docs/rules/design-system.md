---
type: rule
status: proposed
enforcement: blocking
scope: web-desktop-ui
last-reviewed: 2026-09-06
rationale: 공통 Token과 Component를 사용하면서도 화면별 선택과 override로 디자인이 달라지는 것을 방지한다.
evidence: "Issue #86: https://github.com/blahaj94/ldb/issues/86"
exceptions: 화면별 공용 Component 외형 override의 예외는 허용하지 않는다.
review-after: 최초 기준 화면과 공용 자산의 사용자 Review 완료 시
---

# Design System Contract

## 적용 상태와 범위

이 document는 [Issue #86](https://github.com/blahaj94/ldb/issues/86)의 합의에서 공통 자산의 책임과 화면별 외형 override 금지를 정리한 Rule 제안이다. [Change Control](change-control.md)에 따른 Draft PR의 명시적인 `승인` comment 확인 전에는 구현 근거로 사용하지 않는다. `blocking`은 승인 후 위반을 Review에서 수정해야 한다는 뜻이며, 자동 검사 도입이나 검증 성공을 의미하지 않는다.

승인 후 새로 만드는 UI와 수정하는 UI에 적용한다. 기존 화면의 전면 교체를 이 Rule의 승인만으로 착수하지 않는다. 기존 사용처에 영향을 주는 공용 자산 변경은 아래 변경·Review 절차를 따른다.

구체적인 Theme·Token 값·Component 이름과 API·package 배치·app 간 import direction·dependency는 이 Rule에서 정하지 않는다. Motion의 수치와 동작, 계산기의 기능·domain도 별도 결정 범위다.

## 공통 자산과 화면의 책임

| 대상 | 책임 |
| --- | --- |
| Token | 색상·Typography·간격·Radius 등 공통 시각 값과 용도별 기본값을 정의한다. |
| Component·Variant | 요소의 외형과 관련 상태의 표현을 관리하고, 역할에 맞는 선택지를 제공한다. |
| Layout·Pattern | Component 사이 간격, 영역 Padding, 페이지 배치와 정보 밀도의 기본값·적용 조건을 제공한다. |
| 화면 | data·content·event와 의미 있는 상태를 연결하고, 제공된 Component·Variant·Layout 옵션으로 구성한다. |

- 첫 UI부터 필요한 공통 자산을 함께 마련한다. 실제 사용처 개수에 따른 도입 제한은 두지 않으며, [Code Quality](code-quality.md)의 불필요한 abstraction·wrapper 방지 기준을 따른다.
- Token은 허용값 목록과 함께 용도별 기본값을 제공한다. 같은 역할과 적용 조건에는 같은 기본값·Pattern을 사용한다.
- Token·Component·Layout·Pattern의 최초 값은 잠정적일 수 있다. 잠정 상태에서도 공통 정의를 사용하며, 채택 상태·적용 조건·선택 이유는 해당 자산의 문서나 예제에서 확인할 수 있게 한다.
- 화면에서 표현할 요구가 기존 자산에 맞지 않으면 공통 정의 또는 선택지의 변경·추가로 처리한다. 화면 이름만 다른 동일 역할의 Variant를 만들어 기준을 우회하지 않는다.
- 기존 공용 Component로 표현할 수 있는 역할을 화면의 별도 markup·CSS로 다시 구현해 이 기준을 우회하지 않는다.
- 처음부터 모든 화면의 Component·Layout을 만들지 않는다. 실제 UI 요구에 필요한 범위를 정하고, 원시 시각 값은 공통 정의에서 관리한다.

## 화면별 외형 override 금지

- 화면은 공용 Component의 색상·Typography·크기·내부 Padding·Radius·border·shadow·상태별 표현 등을 직접 덮어쓰지 않는다. 외형 변경은 공용 Token·Component·Variant에서 처리한다.
- Component 사이 간격, 영역 Padding, 배치·밀도도 Layout·Pattern의 적용 조건과 제공 옵션으로 표현한다. 화면별 임의 CSS로 공통 기본값을 대체하지 않는다.
- Inline style, `className`, 전역·부모·하위 selector, CSS variable 재정의, wrapper를 통한 override에도 같은 기준을 적용한다. 기존 Token을 참조한 CSS라도 화면이 공용 외형을 덮어쓰면 위반이다.
- Public API는 용도와 적용 조건이 있는 선택지를 제공한다. 화면이 임의의 외형 값을 전달하는 통로를 일반적인 customization API로 제공해 이 기준을 우회하지 않는다.
- 화면의 텍스트·아이콘 source·수치·event 연결과 제공된 상태·Variant·Layout 옵션의 선택은 각 자산의 계약을 따른다. Prop 이름이나 CSS 문법만으로 판정하지 않고, 화면에서 공용 표현을 임의로 변경하는지 확인한다.
- Data에 따라 달라지는 시각 표현도 공용 자산의 책임이다. 화면은 필요한 data·상태를 전달하고, 해당 자산이 그 의미와 시각 표현을 연결한다.

| 사례 | 판정과 처리 |
| --- | --- |
| 화면에서 Button의 배경색·높이·Radius를 직접 지정 | 금지. 공통 기준 변경 또는 역할에 맞는 Variant 추가로 처리한다. |
| 화면의 style에서 기존 spacing Token을 참조해 Button 내부 Padding을 변경 | 금지. Token 사용 여부와 무관하게 공용 외형의 override다. |
| 부모 selector나 wrapper로 Button의 내부 요소를 변경 | 금지. 간접 override도 같은 기준을 적용한다. |
| Component가 제공하는 Variant·상태를 해당 용도에 맞게 선택 | 허용. 선택지의 적용 조건과 공통 기본값을 따른다. |
| Layout이 제공하는 간격·배치·밀도 옵션을 해당 용도에 맞게 선택 | 허용. 같은 역할과 조건에 임의로 다른 옵션을 선택하지 않는다. |
| 새로운 표현이 필요하지만 공용 자산에 해당 선택지가 없음 | 공용 자산의 변경·확장을 제안한다. 화면별 override로 임시 해결하지 않는다. |

## 변경과 Review

1. 요구를 기존 공통 자산과 적용 조건으로 표현할 수 있는지 먼저 확인한다.
2. 변경이 필요하면 공통 기본값 변경과 역할이 구분되는 Variant·Pattern 추가 중 맞는 안을 제시한다. 이유와 영향을 받는 기존 사용처를 함께 드러낸다.
3. 사용자 피드백은 개별 시안의 선택과 공통 기준으로 적용할 범위를 구분한다. 특정 화면의 피드백을 AI가 임의로 전체 Rule로 확대하지 않는다.
4. 채택한 변경은 공용 정의와 관련 사용처에 반영하고 확인한다. 공용 정의만으로 전파되지 않는 변경은 영향받는 사용처와 후속 작업을 명시한다. 새 화면에만 새 기준을 적용하고 기존 화면과의 차이를 숨기지 않는다.

Review에서는 화면과 공통 자산의 변경 위치, override 우회 여부, Variant·Pattern의 적용 조건, 영향을 받는 상태와 기존 사용처를 확인한다. 위반은 해당 변경을 완료한 것으로 판단하기 전에 수정한다.

검증 종류와 필요한 evidence는 [Testing](testing.md)을 따른다. 시각 확인에는 변경한 표현과 관련 상태·사용처를 포함한다. 예제 도구·자동 검사·시각 비교 환경은 별도 구현 범위에서 정한다.

Rule·architecture·dependency·기존 behavior 등의 변경 승인 경계는 [Change Control](change-control.md)을 따른다. 이 document는 별도 승인 단계를 추가하지 않는다.
