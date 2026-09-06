# 공용 UI 준비와 interaction Red

Issue #103의 준비 단계다. `src/index.tsx`는 import·render 실패와 interaction assertion 실패를 구분하기 위한 임시 native render scaffold이며, 아직 제품에서 소비하지 않는다. 승인된 공식 Snippet·CSS·Example 구현은 통합된 Red 확인 뒤 진행한다.

- `pnpm --filter @ldb/ui test`: React DOM과 기존 Vitest/jsdom으로 callback·상태·접근성 연결·Dialog focus를 검사한다. 현재 의도적인 Red다.
- `pnpm --filter @ldb/ui typecheck`
- `pnpm --filter @ldb/ui lint`
- `pnpm install --frozen-lockfile`

`test/interaction.test.tsx`의 enabled/disabled native button 검사는 harness 기준점이다. Loading click 차단, TextField label/control·controlled value callback·invalid/설명/오류 연결, Dialog trigger·이름·초기 focus·Escape/닫기·focus 복귀 검사는 아직 없는 SEED interaction을 요구한다. Library mock이나 import 실패를 Red 근거로 사용하지 않는다. jsdom의 click/event 검사는 실제 pointer/keyboard·Tab/Shift+Tab·시각·Motion 검증을 대신하지 않는다.

`apps/desktop/src/frontend/src/App.test.tsx`는 renderer의 선택값·숫자 interval·등록 전 Start 차단·등록 후 Start/Stop callback을 보존하는 기존 behavior 기준점이다. Capture hook만 격리하며 IPC·media·OCR는 실행하지 않는다. Web counter 보존 검사는 소비 연결 전에 추가하고, 실제 Electron 검증은 별도 격리 환경에서 수행한다.

## 고정 기준과 미구현 범위

선택 기준은 `docs/rules/design-system.md`, peer·CSS 책임은 `docs/architecture/overview.md`를 따른다. Runtime dependency와 Vite plugin은 승인된 exact version으로 선언했으며 CLI는 설치하지 않았다. Peer와 개발 React 사본은 현재 소비 app의 lockfile에 맞춘 `19.2.8`이다.

공식 source 기준은 `daangn/seed-design` commit `08b3600989597f4e9017731484a409685c08aa68`이다. API 확인에 사용한 source는 `docs/registry/react/ui/action-button.tsx`, `docs/registry/react/ui/text-field.tsx`, `docs/registry/react/ui/dialog.tsx`다. 현재 upstream source를 복제한 file은 없으며, scaffold는 LDB 작성 코드다. Green에서는 의존 `loading-indicator`와 Layout block을 포함한 source provenance·변경 diff·각 LICENSE/NOTICE 보존, package external·build·Example·app CSS 소유 검증을 함께 추가한다. 설치된 package 자체의 고지는 package에 유지되며 배포 산출물 고지 검증은 아직 수행하지 않았다.
