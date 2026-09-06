# Red expectation 정정

최초 Red commit `544438972ea0bf3598f995a147989d7526a750f1`의 9개 assertion 실패 evidence는 그대로 유지한다. 공식 source와 실제 package를 연결한 뒤 아래 두 기대값이 승인된 contract보다 강했음을 확인했다. Issue #103 통합 담당 확인 후 test만 별도 commit으로 정정한다.

- ActionButton: 고정 source `08b3600989597f4e9017731484a409685c08aa68`의 `docs/examples/react/action-button/loading.tsx`는 loading이 disabled를 포함하지 않으며 event 차단이 필요하면 disabled를 추가하도록 명시한다. Package `@seed-design/react@2.4.1`의 `src/components/LoadingIndicator/usePendingButton.tsx`도 loading을 data attribute로만 표현한다. Loading-only 자동 차단 가정 대신 공식 loading-only callback 허용과 busy 상태의 loading+disabled 차단을 각각 검증한다. Custom event guard는 추가하지 않는다.
- TextField: AC는 label·value·invalid 연결이며 callback exactly-once를 요구하지 않는다. 공식 Snippet과 `@seed-design/react@2.4.1` 연결에서 하나의 native input event가 같은 `New name` 값을 2회 전달했다. 보고된 모든 값의 집합이 `New name` 하나인지와 부모가 대문자로 변환한 최종 controlled value `NEW NAME`을 검증한다. 값 누락·다른 값·controlled 연결 실패는 계속 실패한다. 호출 횟수 보장이나 duplicate 제거를 새 public contract로 만들지 않는다.

이는 승인 behavior를 통과시키기 위한 runtime 변경이 아니라, 원래 test가 임의로 추가한 두 가정을 제거한 것이다. 실제 pointer/keyboard·Tab·Motion 검증은 jsdom과 분리한다.
