# 공용 SEED UI

`@ldb/ui`는 공식 SEED Snippet·Layout을 제공한다. 제품 data·event·platform 연결은 소비 app이 소유한다. 기준은 `docs/rules/design-system.md`와 `docs/architecture/overview.md`다.

## Public API와 CSS 책임

ActionButton, TextField/TextFieldInput, DialogRoot/Trigger/Content/Body/Footer/Action과 LayoutBlock을 제공한다. ContentStack·ExampleSection·SupportingText는 중립 Example을 위한 LDB composition이며 공식 block의 gap=x6와 Text 역할별 기본값을 공유한다. 공식 이름·semantic prop·ref를 유지하며 runtime wrapper 없이 public prop type에서 임의 style·className·시각 값 override를 제외한다. 내부 `src/seed` 경로는 package export가 아니다.

SEED React `2.4.1`, CSS `2.7.0`, React/React DOM `19.2.8`은 peer이며 소비 환경과 같은 개발 사본을 사용한다. 공식 icon `1.26.0`은 dependency다. Library build는 SEED·React·React DOM·JSX runtime·icon을 external 처리하고 CSS를 출력하지 않는다. 각 browser entry가 `@seed-design/css/base.css`를 한 번 import하고 공식 Vite plugin `2.1.0`을 연결한다. Plugin의 기본 system Theme 초기화와 recipe가 가져오는 CSS를 그대로 사용한다.

Loading은 disabled를 포함하지 않는 공식 상태다. Busy 작업에서 activation을 차단하려면 `loading`과 `disabled`를 함께 전달한다. TextField는 공식 grapheme callback의 `value`를 controlled state에 연결하며 callback 횟수 보장을 추가하지 않는다. Dialog의 기본 outside interaction 닫기 정책은 공식 Snippet의 `false`다.

## Command

- `pnpm --filter @ldb/ui build`: ESM bundle과 portable declaration 생성.
- `pnpm --filter @ldb/ui dev:examples`: 독립 Vite Example.
- `pnpm --filter @ldb/ui build:examples` / `preview:examples`: production Example 생성·확인.
- `pnpm --filter @ldb/ui test`: interaction·접근성 연결과 public type 검사. Layout 크기 관측만 jsdom에서 격리한다.
- `pnpm --filter @ldb/ui typecheck`
- `pnpm --filter @ldb/ui lint`
- `node packages/ui/scripts/verify-build.mjs library packages/ui/dist`: external·CSS 없음·source/고지 hash 검증.
- `node packages/ui/scripts/verify-build.mjs consumer <산출물 경로>`: 단일 React/SEED 사본·base.css 1회·stylesheet 1개·고지 확인.
- `pnpm install --frozen-lockfile`

현재 package command는 repository root에서 실행한다. 소비 app과 Example은 별도 build·시각·keyboard·focus·Motion 검증이 필요하다. jsdom 결과를 실제 browser/Electron 또는 Tab 이동 성공으로 대신하지 않는다.

## Source와 고지

`seed-provenance.json`이 upstream repository·고정 SHA·source path·원본/local hash·전이 Snippet·local diff를 기록한다. 기준 SHA는 `08b3600989597f4e9017731484a409685c08aa68`이다. ActionButton → LoadingIndicator → ProgressCircle과 Dialog → ActionButton, TextField/Dialog의 공식 icon 의존을 포함한다. `LayoutBlock`은 실제 registry id `layout-01`, source `docs/registry/react/block/layout-01.tsx`의 Header+Content+Footer 구조와 공식 반응형 조건을 유지하고 header/footer/children content slot만 연결한 LDB composition이다.

`node packages/ui/scripts/prepare-seed-source.mjs`는 고정 source hash를 확인한 뒤 Snippet을 생성한다. Source 직접 수정 대신 이 생성 script에서 필요한 변환을 관리한다. DialogTrigger의 동일한 public type을 명시해 declaration의 pnpm private 경로 참조를 방지하고 LayoutBlock content slot을 연결하는 변환을 적용한다. Interaction과 시각 값은 변경하지 않는다. TypeScript는 build-time `node` type을 명시하며 library declaration에는 Node runtime을 노출하지 않는다.

`notices`는 SEED source와 별도 icon package의 LICENSE/NOTICE를 보존한다. `build/notices.ts`는 각 build에서 고지·source provenance와 bundle 입력 graph(미사용 입력 포함)의 dependency license/NOTICE·module 목록을 산출물 `notices`에 기록한다. Absolute filesystem path는 이 목록에 저장하지 않는다. 최초 Red와 정정한 두 기대값의 근거는 `test/contract-corrections.md`에 남겼다.
