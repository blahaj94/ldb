---
type: reference
status: active
enforcement: autonomous
scope: shared-ui-validation
last-reviewed: 2026-09-07
---

# 공용 UI 검증 기록

Issue #103의 최초 구현 검증이다. 최종 runtime/source head는 `abb40ca926c8920ebbe8aa8a9094a378235e5e89`이며, 이 기록의 추가는 문서 변경만 포함한다. 초기 넓은 interaction matrix는 `1643e73025fecf1058dcbfe2b8ad6bf706cd24f6`에서 시작했다. 이후 차이는 changed-file 고지와 artifact 검사이며, 최종 head의 Example dev reload·production Example/Web·실제 Electron renderer를 다시 확인했다.

Source·public API·재현 command·fixture 경계는 `packages/ui/README.md`, upstream/local hash와 변경 고지는 `packages/ui/seed-provenance.json`을 따른다. 실행 log나 원 대화는 이 문서에 복제하지 않는다.

## 기준과 환경

- Source: `daangn/seed-design`의 `08b3600989597f4e9017731484a409685c08aa68`.
- Package: SEED React `2.4.1`, CSS `2.7.0`, icon `1.26.0`, Vite plugin `2.1.0`, React/React DOM `19.2.8`.
- OS: macOS `26.6.2`, arm64. Chrome 설치 version `152.0.7977.77`; 실제 DevTools의 major도 152다.
- 실제 Electron: `39.8.10`, Chromium `142.0.7444.265`, Node `22.22.1`. Build shell Node와 Electron 내장 Node를 구분한다.
- Font: 공식 system font stack. Chrome의 computed body font는 `-apple-system`, `system-ui`, `Apple SD Gothic Neo` 등의 해당 stack이며 root rem 기준은 `16px`였다. Electron의 실제 Styles panel에서도 같은 body stack을 확인했다. 개별 glyph의 최종 fallback face까지 식별한 것은 아니다.
- ActionButton: `brandSolid`, `neutralSolid`, `neutralWeak`, `criticalSolid`, `neutralOutline`, `ghost`; size `medium`, layout `withText`. TextField는 `outline`/`large`, Dialog는 기본 `medium`이다.
- 공용 Component는 고정 Snippet·recipe와 동일한 semantic prop을 사용한다. Layout은 `layout-01`의 구조·Token·breakpoint를 유지한 content-slot LDB composition이다. 화면별 외형 override나 다른 OS 간 pixel 동일을 주장하지 않는다.

## 자동 검증

통합 담당도 같은 최종 runtime head에서 아래 결과를 재현했다. Root placeholder test는 사용하지 않았다.

| 대상 | 실행과 결과 |
| --- | --- |
| 설치 | `pnpm install --frozen-lockfile` 통과 |
| 공용 package | `pnpm --filter @ldb/ui test`: 13개 통과. `typecheck`, `lint`, `build`, `build:examples` 통과 |
| Web | `pnpm --filter @ldb/web test`: 1개 통과. `typecheck`, `lint`, `build` 통과 |
| Desktop | `pnpm --filter @ldb/desktop test`: 29개 통과. `typecheck`, `lint`, `build` 통과 |
| Library artifact | `node packages/ui/scripts/verify-build.mjs library packages/ui/dist` 통과 |
| Consumer artifact | 같은 verifier의 `consumer` mode로 `packages/ui/dist-examples`, `apps/web/dist`, `apps/desktop/out/frontend` 모두 통과 |
| Diff | `git diff --check` 통과 |

Library JS bundle의 runtime dependency 입력은 0이며 React/JSX runtime·SEED·icon을 external import로 유지한다. Library build의 CSS 출력은 0이다. 별도 public `foundation.css` asset은 각 browser entry에서 직접 소비한다. 세 consumer의 build 입력 graph에서 React/React DOM/SEED React/CSS는 각각 한 사본이며 base.css와 foundation font stack은 한 번, stylesheet 산출물은 한 개다. Graph는 tree-shaking 전 입력도 포함하는 보수적인 검사다.

원본 LICENSE/NOTICE, modified source와 declaration의 changed-file notice, 생성 JS banner, `notices/LDB-MODIFICATIONS.txt`와 provenance를 확인했다. 생성 bundle 목록만 changed-file 검사의 대상으로 삼으며, 수정하지 않은 기존 OCR public worker에 LDB 변경 고지를 붙이지 않는다.

최초 Red는 `544438972ea0bf3598f995a147989d7526a750f1`의 9개 interaction assertion 실패와 2개 native 기준점 통과다. Import/render 실패를 Red로 계산하지 않았다. 공식 loading-only와 callback 횟수에 대한 두 test 가정의 정정 근거는 `packages/ui/test/contract-corrections.md`에 있다.

## 실제 UI 결과

모든 UI 조작은 CUA의 browser/native interface로 수행했다. Browser dev와 production, 실제 Electron renderer를 구분한다.

| 환경 | 관측 결과 |
| --- | --- |
| Example dev, Chrome | Enabled/loading-only pointer·Enter/Space callback, busy pointer 차단, disabled/busy Tab skip 통과. Controlled 입력이 Dialog body에 반영됨. Label·description·invalid error 연결, disabled·read-only 상태 확인. Read-only에 key를 입력해도 값 유지 |
| Example dev Dialog, Chrome | Accessible title·설명, 열기와 초기 dialog focus, Tab/Shift+Tab 순환, Escape·닫기·DialogAction 종료와 trigger focus 복귀 통과. 퇴장 animation이 끝난 후 focus를 판단 |
| Example production, Chrome | 최종 artifact에서 loading-only keyboard callback, 입력→Dialog 표시, 양방향 focus containment·명시 닫기/복귀, stylesheet 1개와 실제 font stack 확인. Console error/warn 0 |
| Web dev/production, Chrome | Counter가 pointer와 keyboard activation으로 각각 0→1→2. 기존 설명·link content 유지. Shared Button의 실제 height 40px·radius 8px와 font stack 확인. Light↔system-dark 전환 후 counter 값 유지. Production stylesheet 1개, Console error/warn 0 |
| Desktop production, 실제 Electron | Light와 최종 dark artifact에서 초기 Start disabled, synthetic source 선택 후 활성화, Start callback→`UI fixture: media capture blocked.`, Tab+Space Stop→`Capture stopped.` 확인. 5초 interval 선택 반영. 실제 stream·OCR는 실행하지 않음 |
| Example production, 실제 Electron | Dark/light 외형 확인. Loading-only keyboard callback, disabled/busy Tab skip, native 입력→Dialog body, keyboard 열기/초기 focus, Tab·Shift+Tab 순환, Escape·명시닫기와 trigger focus 복귀 통과 |
| Example reduced-motion, 실제 Electron | Target DevTools에서 reduce를 선택한 뒤 keyboard 열기·초기 dialog focus, 양방향 Tab, Escape/trigger 복귀 유지 |

### Layout·viewport

Chrome에서 `390×844`의 좁은 화면과 긴 중립 Dialog content를 확인했다. Dialog의 client/scroll 크기는 `351×232`로 같았고 줄바꿈·footer 접근이 유지됐다. 다음 공식 breakpoint 양쪽에서 Layout의 가로 overflow는 없었다.

| Chrome viewport width | Layout content width | computed max-width |
| --- | --- | --- |
| 767 | 767 | none |
| 768 | 720 | 720px |
| 1279 | 720 | 720px |
| 1280 | 1040 | 1040px |

Web은 `390×844`와 `1280×900`에서 기존 content 줄바꿈과 counter를 확인했고 document 가로 overflow는 없었다.

실제 Electron Example은 기본 `1100×800` fixture 창과 native DevTools의 Responsive UI에 표시된 `390×844`, `1280×900` viewport에서 확인했다. 좁은 화면의 header·설명·field·Pattern·footer 줄바꿈, 넓은 화면의 가운데 정렬된 Layout, 세로 scroll과 가로 잘림 없는 배치를 시각적으로 확인했다. 이 native 관측은 Chrome의 수치 측정을 대신 사용한 것이 아니며, native scrollWidth 수치를 별도로 측정한 결과로 주장하지 않는다. Console paste 보호로 DOM 수치 조회는 실행되지 않았고 해당 보호도 해제하지 않았다.

### Motion과 검증된 upstream 지원 제한

Chrome의 실제 DevTools UI에서 light와 reduced-motion을 emulation했다. Normal motion과 reduce에서 interaction·focus는 유지됐다.

- 실제 pointer/keyboard callback과 별도로, DevTools의 `:hover`, `:active`, `:focus-visible`를 강제해 시각 State를 확인했다. 기본 medium Button은 height 40px·radius 8px였고 hover 색상 변화와 2px focus outline/2px offset을 확인했다. 강제 pressed scale은 해당 폭에서 약 `0.990938`, reduce에서는 `1`이었다. 강제 State 검사를 실제 pointer hold screenshot으로 부르지 않는다.
- Reduce에서 ActionButton `--seed-feedback-scale`과 root `--seed-scale-s95`는 `1`로 변경됐다.
- Dialog는 reduce에서도 `--seed-enter-scale: 1.3`, `seed-enter` 200ms를 유지했다. 이는 실제 관측한 upstream 지원 제한이다.
- Spinner도 reduce에서 `rotate`/head/tail animation 1.2초, running 상태를 유지했다. 서로 다른 관측의 transform matrix가 바뀌어 실제 회전 지속을 확인했다.
- Dialog와 Spinner의 남은 Motion을 없애는 자체 override는 추가하지 않았다. Electron에서도 reduce 하의 focus를 실제 확인했지만 위 수치·transform 측정값은 Chrome 관측이다.

## 경계와 정리

Windows/Linux, 다른 OS font rendering, 실제 capture/OCR·OS capture permission·계정·auth·배포/packaging 성공은 이번 UI evidence의 범위가 아니다. Native Example fixture에서는 CSP가 설정되지 않은 독립 Example을 로드하므로 Electron의 CSP 진단 경고가 표시됐다. 해당 fixture는 제품 main/preload를 사용하지 않고 sandbox·permission 거절·media stub을 유지했다. Security 설정을 완화하거나 Console paste 보호를 해제하지 않았다.

Chrome의 강제 pseudo-state를 모두 해제하고 color-scheme/reduced-motion을 No emulation으로 복구했다. Viewport override를 reset한 뒤 task가 만든 tab만 닫았다. Native device toolbar를 껐고, native media emulation은 해당 disposable fixture의 종료·profile 삭제로 정리했다. Task 소유 Electron process, 네 개의 loopback dev/preview server, 잔여 fixture profile을 정리했다. 사용자 원래 tab/app이나 OS preference는 변경하지 않았다.

## Fresh consumer resolution 수정

PR #104 merge 이후 발견된 cold resolution 회귀의 Green은 `215bedcbf116b6caa53c2ca4068734d27b9f5a18`다. Red·격리 조건·실제 command 결과는 `packages/ui/test/consumer-resolution.md`를 따른다. Source alias는 현재 public source를 직접 소비하며, 이전 artifact 선행 build를 cold 성공 근거로 사용하지 않는다.

기준 `1f2434b`와 비교해 `packages/ui/src`, `foundation.css`, Example source, Web/Desktop product source, package manifest와 lockfile은 변경되지 않았다. 여섯 consumer config의 resolution 및 build-time type만 바뀌었으므로 위 interaction·Theme·Motion·responsive matrix를 이 불변 범위에서 재사용했다. 새 전체 matrix를 수행했다는 뜻이 아니다.

- Web `dev`: 실제 Chrome guest window에서 정상 렌더, dark 배경과 SEED ActionButton의 orange/focus 외형을 확인했다. Pointer로 Count 0→1, Space로 1→2가 됐다. 현재 browser connector가 없어 native UI로 확인했으며 새 DOM computed-style 수치는 측정하지 않았다.
- Desktop dev: 실제 electron-vite renderer config를 읽는 별도 Vite server의 main/App HTTP entry가 정상 해석됐다. `--rendererOnly`도 Electron bootstrap을 호출하므로 제품 `dev`를 실행한 결과로 부르지 않는다.
- 실제 Electron renderer: 기존 `ui:fixture desktop dark`로 새 production renderer를 열었다. 선택 전 Start disabled, Example window 선택 후 enabled, Start의 media 거절 stub 상태, Tab+Space Stop의 `Capture stopped.`와 SEED 스타일을 확인했다. Fixture는 1100×800 window를 사용했다. 이 확인은 dev URL을 Electron에서 연 결과와 구분한다.

Web guest window와 dev server를 닫고 Electron fixture의 정상 종료를 확인했다. 제품 main/preload·실제 capture/OCR는 실행하지 않았다. 기존 다른 OS·packaging·실제 native 동작의 미검증 범위는 유지한다.
