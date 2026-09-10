---
type: rule
status: active
enforcement: blocking
scope: web-desktop-ui
last-reviewed: 2026-09-07
rationale: 공통 Token과 Component를 사용하면서도 화면별 선택과 override로 디자인이 달라지는 것을 방지한다.
evidence: "PR #89 사용자 승인: https://github.com/blahaj94/ldb/pull/89#issuecomment-5559313457"
exceptions: 화면별 공용 Component 외형 override의 예외는 허용하지 않는다.
review-after: 최초 Template Example과 공용 자산의 사용자 Review 완료 시
---

# Design System Contract

## 적용 상태와 범위

이 document는 [Issue #86](https://github.com/blahaj94/ldb/issues/86)의 합의에 대한 [PR #89 사용자 승인](https://github.com/blahaj94/ldb/pull/89#issuecomment-5559313457)을 반영한 Rule이다. 공통 자산의 책임과 화면별 외형 override 금지가 승인 범위다. `blocking`은 위반을 Review에서 수정해야 한다는 뜻이며, 자동 검사 도입이나 검증 성공을 의미하지 않는다.

승인 후 새로 만드는 UI와 수정하는 UI에 적용한다. 기존 화면의 전면 교체를 이 Rule의 승인만으로 착수하지 않는다. 기존 사용처에 영향을 주는 공용 자산 변경은 아래 변경·Review 절차를 따른다.

SEED 채택 변경분은 [채택 결정](https://github.com/blahaj94/ldb/issues/86#issuecomment-5560112909)을 근거로 PR에서 제안한다. 기존 active Rule의 승인은 유지하며, 추가 Rule·architecture·dependency 구현은 현재 Issue가 substantive contract의 채택과 실행을 허용할 때 같은 PR에 준비할 수 있다. 그 범위를 명시한 PR의 사용자 merge가 문서 변경을 승인·활성화하며, 절차 문구나 link만 수정하면 기존 status를 바꾸지 않는다. 별도 metadata 활성화 작업은 요구하지 않는다. 제품 behavior·API·인증·domain·platform contract는 변경하지 않는다.

## SEED 재사용 기준

- [SEED Design](https://seed-design.io/)의 공식 styled Component·recipe·Token·Variant·State와 기본값을 직접 사용한다. 같은 역할·조건에는 공식 이름과 semantic 선택을 유지하고, 공식 정의가 있는 palette·spacing·Typography·Radius·border·shadow·밀도 등을 독자적으로 다시 정하지 않는다.
- 공식 Foundations의 [Typography](https://seed-design.io/foundations/typography)와 system font stack, 기본 system mode의 Theme, [responsive Layout](https://seed-design.io/foundations/layout), Pattern의 적용 조건을 따른다. 별도 font나 LDB 전용 scale로 대체하지 않는다. 전체 화면 구성이 공식 Example과 같다는 뜻은 아니며, 재사용한 요소와 조합의 출처를 구분한다.
- [Motion](https://seed-design.io/foundations/motion)은 해당 공식 Component·recipe·Snippet의 transition·duration·easing·scale feedback·진입/퇴장 동작을 유지한다. Reduced-motion은 해당 공식 구현이 제공하는 처리를 보존·검증하고, 제공되지 않거나 검증하지 못한 범위를 기록한다. 모든 Component에 동일한 지원이 있다고 가정하지 않는다. 독자 Apple Motion preset이나 추가 Motion engine을 초기 기준으로 만들지 않는다. 공식 구현에 없는 동작·접근성 요구는 누락을 명시하고 공용 변경으로 검토한다.
- 공식 Snippet은 해당 styled Component와 의존 Snippet을 함께 연결한다. 재사용 가능한 공식 Layout block·Pattern이 있으면 그 구조·반응형 조건을 따른다. 대응물이 없으면 **LDB composition**으로 표시하고 사용한 공식 요소와 추가 조합·선택 이유를 기록한다. 없는 값을 공식 SEED 값이라고 부르거나 공식 시각 기준을 임의로 대체하지 않는다.
- SEED의 상표·로고·제품 예시 content를 LDB의 정체성이나 domain으로 복제하지 않는다. 공용 package와 CSS 소유 책임은 [Shared UI boundary](../architecture/overview.md#shared-ui-boundary)를 따른다.

## Version과 Source

초기 고정 조합은 다음과 같다. Package의 version 숫자는 서로 독립적이며, 이 표는 실제 Web·Electron 호환성 검증 결과가 아니다.

| 역할 | 고정 package |
| --- | --- |
| Runtime styled Component | `@seed-design/react@2.4.1` |
| Runtime Token·recipe·style | `@seed-design/css@2.7.0` |
| 공식 Snippet icon | `@karrotmarket/react-monochrome-icon@1.26.0` |
| Vite build 통합 | `@seed-design/vite-plugin@2.1.0` |
| Authoring 전용 CLI | `@seed-design/cli@1.7.0` |

- 문서·Snippet registry의 기준은 [공식 source commit `08b3600989597f4e9017731484a409685c08aa68`](https://github.com/daangn/seed-design/tree/08b3600989597f4e9017731484a409685c08aa68)이다. CLI version만으로 원격 registry가 고정되지 않으므로 가져올 source revision과 내용도 확인한다. 이 Rule 제안에서는 source를 vendor하거나 CLI를 실행하지 않는다.
- Snippet을 가져올 때 upstream repository·commit·file path, 의존 Snippet·package, local destination, license·NOTICE와 local 변경 이유·diff를 추적한다. Action Button에는 `loading-indicator`, Text Field Input에는 공식 icon, Dialog에는 공식 icon과 `action-button` 및 그 전이 의존 Snippet이 필요하다.
- 가져오는 각 source·package의 license와 고지를 확인하고 [LICENSE](https://github.com/daangn/seed-design/blob/08b3600989597f4e9017731484a409685c08aa68/LICENSE)·[NOTICE](https://github.com/daangn/seed-design/blob/08b3600989597f4e9017731484a409685c08aa68/NOTICE)의 적용되는 저작권·귀속 고지를 보존한다. 수정 source에는 변경 사실을 기록한다. Icon 등 별도 package의 고지까지 SEED repository의 license로 대신하지 않는다.
- Published package의 정확한 version·integrity, source SHA, live 문서 확인 시점을 구분해 기록한다. Package와 Snippet·문서 사이에 해당 API·behavior·style·요구 조건의 불일치가 있으면 영향받는 채택·구현을 멈추고 Planner에게 근거와 차이를 전달한다. 독립적인 package version 숫자나 선택한 version을 함께 허용하는 peer 범위의 표기 차이만으로 호환성 문제를 단정하지 않는다. 새 문서나 CLI의 최신 결과로 조용히 덮어쓰지 않는다.
- Upgrade에서는 release note·migration guide·peer 범위와 실제 dependency graph, Token·recipe·기본 Variant·Theme·Motion·Snippet 변경 및 local diff를 확인한다. 소비 app과 Example의 고정 조합을 함께 갱신하고 아래 검증 matrix를 재실행한다. Peer 범위가 맞는다는 사실만으로 runtime 호환성이나 시각 동등성을 선언하지 않는다.

## 용어

디자인 시스템의 정의와 Example에는 제품 도메인에 종속되지 않는 UI 용어를 사용한다. 아래 용어는 문서와 Review에서 같은 의미로 사용한다.

| 용어 | 의미 |
| --- | --- |
| Token | 색상·Typography·간격 등 공통 시각 값을 표현하는 Design Token. |
| Component | 특정 UI 역할을 담당하는 재사용 가능한 요소. |
| Variant | Component가 제공하는 용도·외형의 선택지. |
| State | focus·disabled·selected 등 Component의 현재 상태. |
| Layout | 요소의 간격·정렬·크기와 공간 배치를 정하는 구조. |
| Pattern | 반복되는 UI 목적에 대응하는 Component 조합과 상호작용 방식. |
| Template | Component·Pattern을 배치한 페이지 단위 구조. |
| Example | Variant·State·조합의 시각 표현과 동작을 확인하는 실행 가능한 예제. |

검토 대상에 따라 `Component Example`, `Pattern Example`, `Template Example`로 부른다. Example은 제품 도메인에 의존하지 않는 예시 content·data를 사용한다. 최초 Example 범위와 유지 방식은 아래 Example 관리 절을 따른다. 이 용어 자체가 별도의 code layer를 요구하지 않는다.

위 표는 LDB의 Review 분류 용어이며 실제 외형·interaction·API 선택은 SEED 재사용 기준을 따른다. Template Example은 공식 SEED Layout block에 연결한다.

## 공통 자산과 화면의 책임

| 대상 | 책임 |
| --- | --- |
| Token | 색상·Typography·간격·Radius 등 공통 시각 값과 용도별 기본값을 정의한다. |
| Component·Variant | 요소의 외형과 관련 상태의 표현을 관리하고, 역할에 맞는 선택지를 제공한다. |
| Layout·Pattern | Component 사이 간격, 영역 Padding, 페이지 배치와 정보 밀도의 기본값·적용 조건을 제공한다. |
| 화면 | data·content·event와 의미 있는 상태를 연결하고, 제공된 Component·Variant·Layout 옵션으로 구성한다. |

- 첫 UI부터 필요한 공통 자산을 함께 마련한다. 실제 사용처 개수에 따른 도입 제한은 두지 않으며, [Code Quality](code-quality.md)의 불필요한 abstraction·wrapper 방지 기준을 따른다.
- Token은 허용값 목록과 함께 용도별 기본값을 제공한다. 같은 역할과 적용 조건에는 같은 기본값·Pattern을 사용한다.
- SEED가 정의한 Token·Component·Layout·Pattern의 최초 값과 기본값은 그대로 사용한다. 공식 대응물이 없는 LDB composition은 채택 상태·적용 조건·선택 이유를 공용 자산의 문서나 Example에 기록하며, 이 구분을 독자 시각 값 선정의 허가로 사용하지 않는다.
- 화면에서 표현할 요구가 기존 자산에 맞지 않으면 공통 정의 또는 선택지의 변경·추가로 처리한다. 화면 이름만 다른 동일 역할의 Variant를 만들어 기준을 우회하지 않는다.
- 기존 공용 Component로 표현할 수 있는 역할을 화면의 별도 markup·CSS로 다시 구현해 이 기준을 우회하지 않는다.
- 처음부터 모든 화면의 Component·Layout을 만들지 않는다. 실제 UI 요구에 필요한 범위를 정하고, 원시 시각 값은 공통 정의에서 관리한다.

## 화면별 외형 override 금지

- 화면은 공용 Component의 색상·Typography·크기·내부 Padding·Radius·border·shadow·상태별 표현 등을 직접 덮어쓰지 않는다. 외형 변경은 공용 Token·Component·Variant에서 처리한다.
- Component 사이 간격, 영역 Padding, 배치·밀도도 Layout·Pattern의 적용 조건과 제공 옵션으로 표현한다. 화면별 임의 CSS로 공통 기본값을 대체하지 않는다.
- Inline style, `className`, 전역·부모·하위 selector, CSS variable 재정의, wrapper를 통한 override에도 같은 기준을 적용한다. 기존 Token을 참조한 CSS라도 화면이 공용 외형을 덮어쓰면 위반이다.
- SEED가 임의 style prop을 제공하더라도 LDB 화면 override를 허용하는 근거가 되지 않는다. 공식 문서의 semantic Variant·State·Layout 선택과 공용 composition으로 표현한다.
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

## Example 관리

- Component Example·Pattern Example·Template Example의 source, 필요한 예시 content·data와 실행 안내를 공용 자산과 같은 repository에서 version 관리한다.
- Example은 해당 revision의 공용 자산과 public API를 직접 사용한다. Example에도 앞의 공통 자산 사용과 외형 override 금지 기준을 적용한다.
- 공용 자산을 추가하거나 외형·동작·public API·적용 조건을 변경하면, 그 영향을 확인하는 Example을 같은 PR에서 추가·갱신하고 검증한다. 변경한 Variant·State·조합과 영향을 받는 Pattern·Template을 기준으로 관련 Example의 범위를 정한다.
- 공용 자산의 직접 참조로 변경이 전파되고 Example의 구성과 기대 결과 설명이 여전히 유효하면, 실행 확인으로 동기화를 검증한다. Example file의 수정 여부만으로 갱신·검증 여부를 판단하지 않는다.
- Example의 API 사용, 예시 content·data, 기대 결과 설명과 실행 안내가 변경 후에도 일치하도록 유지한다. 공용 자산 변경과 관련 Example의 필요한 갱신을 별도 후속 작업으로 미루지 않는다.
- PR에는 관련 Example의 file path, 실행 command, 확인한 Variant·State·조합과 결과를 남긴다. 검증 evidence는 [Testing](testing.md)을 따르며, Example을 수정했다는 사실만으로 검증 성공을 판단하지 않는다.

최초 구현의 범위는 공식 Action Button·Text Field Input·Dialog의 Component Example, 이 요소를 조합한 도메인 중립 Pattern Example, 공식 Layout block 기반 Template Example이다. LDB 고유 조합은 LDB composition으로 표시한다. [공식 Vite 설치](https://seed-design.io/react/getting-started/installation/vite)를 따르는 작은 독립 Example entry를 사용하며 상세 file 배치·자동화는 후속 구현에서 정한다. 별도 gallery framework나 Storybook·Base UI·Radix·Stackflow를 초기 직접 dependency로 추가하지 않는다. SEED 내부의 전이 dependency를 임의로 제거하라는 뜻은 아니다.

## 향후 구현 검증 matrix

다음은 구현·upgrade 시 수행할 검증이다. 이번 문서 변경에서 실행했거나 전체 pixel 일치를 달성했다는 주장이 아니다. 각 evidence에는 source SHA·package 조합, 대상 Example·사용처, Variant·State, viewport·Theme·OS·browser/runtime·font 환경을 기록한다.

| 대상 | 확인할 조합과 기대 결과 |
| --- | --- |
| Component 시각 | Action Button의 적용 Variant·size·기본/hover/focus/pressed/disabled/loading, Text Field Input의 기본/focus/disabled/read-only/invalid 및 label·설명·icon, Dialog의 열린 상태를 같은 공식 Variant·State·viewport·Theme와 비교한다. 해당 API가 제공하는 상태만 사용한다. 색상·간격·Typography·크기·Radius·상태 표현의 차이를 설명한다. |
| Layout·Pattern·Template | 공식 Layout의 breakpoint 양쪽과 좁은/넓은 viewport, 긴 중립 content에서 간격·정렬·overflow·줄바꿈·영역 배치를 확인한다. 공식 대응 영역과 LDB composition의 비교 범위를 분리한다. |
| Theme·font | 지원하는 공식 light/dark Theme와 system preference 전환, 각 검증 OS의 공식 system font fallback에서 가독성·줄바꿈·style 중복을 확인한다. 서로 다른 OS font rendering을 무조건 pixel 동일로 간주하지 않는다. |
| Interaction·접근성 | Action Button의 pointer/keyboard 실행·disabled/loading 차단, Text Field Input의 입력·label/설명/오류 연결, Dialog의 열기·Tab/Shift+Tab focus containment·Escape 닫기·focus 복귀와 접근 가능한 이름을 확인한다. |
| Motion | 공식 진입/퇴장·상태 전환·scale feedback을 동일 조건에서 비교하고 reduced-motion preference에서도 동작·focus가 유지되는지 확인한다. 공식 대응이 없는 항목은 검증 공백 또는 LDB 추가 요구로 명시한다. |
| 소비 환경 | 독립 Vite Example와 실제 Web app에서 dev·production build를 확인하고, 실제 Electron renderer에서 CSS·Theme·font·keyboard·focus·Motion을 별도 확인한다. Browser 확인을 Electron 또는 native platform 검증으로 대신하지 않는다. |

시각 비교에는 같은 content와 조건의 공식 기준을 사용하고 기대한 차이·허용 근거·미검증 범위를 남긴다. Screenshot만으로 interaction 성공을 판단하지 않는다. 구체적 실행 command와 test evidence는 구현 PR에서 [Testing](testing.md)에 따라 제공한다.

## 변경과 Review

1. 요구를 기존 공통 자산과 적용 조건으로 표현할 수 있는지 먼저 확인한다.
2. 변경이 필요하면 공통 기본값 변경과 역할이 구분되는 Variant·Pattern 추가 중 맞는 안을 제시한다. 이유와 영향을 받는 기존 사용처를 함께 드러낸다.
3. 사용자 피드백은 개별 시안의 선택과 공통 기준으로 적용할 범위를 구분한다. 특정 화면의 피드백을 AI가 임의로 전체 Rule로 확대하지 않는다.
4. 채택한 변경은 공용 정의와 관련 사용처에 반영하고 확인한다. 공용 정의만으로 전파되지 않는 변경은 영향받는 사용처와 후속 작업을 명시한다. 새 화면에만 새 기준을 적용하고 기존 화면과의 차이를 숨기지 않는다.

Review에서는 화면과 공통 자산의 변경 위치, override 우회 여부, Variant·Pattern의 적용 조건, 영향을 받는 상태와 기존 사용처, 관련 Example의 갱신·검증을 확인한다. 위반은 해당 변경을 완료한 것으로 판단하기 전에 수정한다.

검증 종류와 필요한 evidence는 [Testing](testing.md)을 따른다. 시각 확인에는 변경한 표현과 관련 상태·사용처를 포함한다. 예제 도구·자동 검사·시각 비교 환경은 별도 구현 범위에서 정한다.

Rule·architecture·dependency·기존 behavior 등의 변경 승인 경계는 [Change Control](change-control.md)을 따른다. 이 document는 별도 승인 단계를 추가하지 않는다.
