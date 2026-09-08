---
type: reference
status: active
scope: desktop OCR character search implementation and isolated verification
last-reviewed: 2026-09-08
---

# Desktop 캐릭터 검색

기존 OCR 안정화 결과를 현재 capture의 네 슬롯 검색으로 연결한다. 정책은 [Desktop 검색 계약](../rules/desktop-auth.md#ocr-검색-연결-제안)과 [인증 준비 미완료 보완](../rules/desktop-auth.md#인증-준비-미완료-검색-종료-제안)을 따른다. 기본 제품 main은 여전히 인증 미구성이며 native media를 거절한다. 검색 module 구현과 production 인증·media 활성화는 별개다.

## 구현 위치

| 위치 | 책임 |
| --- | --- |
| `apps/desktop/src/backend/capture/ipc-handler.ts` | 현재 auth/source/document와 capture를 결합하고 검색 IPC·media를 같은 수명에서 검사한다. Navigation, destruction, renderer process 종료, source·auth 변경 때 요청을 무효화한다. |
| `apps/desktop/src/backend/search/capture-lifetime.ts` | 네 슬롯의 최신 관측·requestId·상태, clear/retry와 429 버튼 대기를 소유한다. |
| `apps/desktop/src/backend/search/request.ts` | 입력 접수부터 authorization·body 검증·401 회복까지 하나의 검색 예산과 취소 판정을 수행한다. |
| `apps/desktop/src/backend/search/http.ts` | 고정 `GET /characters`, 선택 query 생략, HTTP/UTF-8/JSON/전체 후보 검증과 다섯 field projection을 수행한다. |
| `apps/desktop/src/backend/search/retry-after.ts` | 헤더 수신 시각부터 남은 시간을 검사하고 긴 timer를 지원 범위 안에서 나눠 예약한다. |
| `apps/desktop/src/preload/common/types/search.ts`, `common/search/snapshot.ts` | Shared DTO·오류 문구·feature API와 exact own shape·상태 조합 검증을 정의한다. |
| `apps/desktop/src/preload/api/search.ts`, `search-command.ts`, `capture.ts` | `window.search`의 제어/구독과 기존 `window.api`의 확장된 OCR 통지를 연결한다. Electron event와 부적합 DTO는 전달하지 않는다. |
| `apps/desktop/src/frontend/src/search/connection.ts` | 구독 후 read, run/revision 순서, 유실된 명령의 조회만 재시도하는 연결 수명을 소유한다. |
| `apps/desktop/src/frontend/src/search/capture-search.ts`, `useCharacterSearch.ts` | Start별 수명, 로컬 관측 revision, 즉시 표시 제거와 슬롯별 retry 진행 상태를 연결한다. |
| `apps/desktop/src/frontend/src/auth/capture-context.ts`, `AuthBridge.tsx`, `useAuthBridge.ts` | Main에서 받은 현재 auth snapshot과 읽기 재동기화를 capture에 전달한다. 별도 인증 상태 머신이나 token 전달은 없다. |
| `apps/desktop/src/frontend/src/capture/usePartyCaptureSession.ts`, `usePartyRecognition.ts` | begin 완료 뒤 media/OCR 시작, 늦은 begin의 자기 ID 정리와 stable/null 전이 통지를 연결한다. 기존 OCR 안정화·기본 3초 간격은 유지한다. |
| `apps/desktop/src/frontend/src/search/SearchResults.tsx` | 네 슬롯의 상태·후보·고정 오류·수동 retry를 text로 표시한다. |

Begin의 직접 성공 응답만 해당 Start가 소유한 ID로 사용한다. 응답이 유실되면 read로 상태를 확인하지만 그 결과의 ID를 늦은 Start의 소유로 추정해 end하지 않는다. 해당 시작은 창을 다시 선택하도록 안내하며 같은 begin을 자동 재전송하지 않는다. 새 source 선택은 기존 main 선택/capture 무효화 경로를 사용한다.

검색 run이 바뀌면 이전 구독·표시·capture resource를 버리고 auth 재동기화와 새 조회를 시작한다. 초기 read가 성공하기 전에는 Start와 직접 begin 호출을 차단하며, 조회 실패 시 기존 앱 화면 다시 열기 안내를 유지하고 event만으로 회복하거나 자동 재시도하지 않는다. 로컬 관측·clear·Stop·source 변경은 main 응답을 기다리지 않고 이전 표시를 가린다. Renderer와 preload는 같은 DTO 검증기를 각각의 경계에서 사용한다.

## UI 구성

기존 `@ldb/ui`의 ActionButton, ContentStack, ExampleSection, SupportingText를 조합한다. 후보의 ordered list와 슬롯별 이름 있는 section은 LDB composition이며 공용 자산의 외형을 덮어쓰는 CSS·style은 없다. 각 슬롯에는 “슬롯 1 검색” 형태의 접근 가능한 이름, 진행 시 `aria-busy`와 상태 안내가 있다. Retry의 loading과 disabled는 함께 적용하며 한 슬롯의 진행이 다른 슬롯 버튼을 막지 않는다.

Keyboard·focus·좁은 화면·theme·reduced-motion의 실제 Electron 관측은 최종 실행 head의 Issue/PR evidence에 기록한다. 공용 spinner의 기존 motion 동작을 변경하지 않으며 unit 성공을 native UI 검증으로 대신하지 않는다.

## 격리 미디어와 화면 검증

기존 [auth capture fixture](desktop-auth-capture.md)를 사용한다. `scripts/auth-capture-fixture/search-effects.ts`의 transport는 고정 합성 origin·endpoint·query·인증 값만 받아 메모리에서 Response를 만든다. 전역 fetch나 실제 API·provider를 호출하지 않는다. `session.webRequest` 차단을 main Node HTTP 차단의 근거로 사용하지 않는다.

앱 메뉴에서 아래 응답을 선택한 뒤 **Stop → Start**로 새 OCR 관측을 만들거나 현재 실패의 **다시 시도**를 누른다. 메뉴 선택 자체는 검색을 보내거나 진행 중 응답을 바꾸지 않는다. 로그인과 source 선택은 기존 fixture 절차를 따른다.

| 메뉴 | 다음 검색의 관측 |
| --- | --- |
| 검색 응답: 성공 | 합성 후보 한 건과 다섯 field 표시 |
| 검색 응답: 0건 | 후보 없이 “검색 결과가 없습니다.” 표시 |
| 검색 응답: 서버 오류 | 고정 오류와 활성화된 수동 retry |
| 검색 응답: 5초 제한 | 429 안내와 비활성 retry, main 대기 만료 뒤 같은 실패의 버튼만 활성화 |
| 검색 응답: 시간 초과 대기 | pending 표시 후 제품의 전체 검색 예산 만료, 종료·Stop 시 abort |

Main 접수 계측은 결과의 `ok:true`와 capture/slot/nickname/observationRevision의 정확한 일치를 확인한다. 더 높은 snapshot 관측 revision은 오래된 입력의 접수 증거가 아니다. 원문 payload를 저장하지 않고 counter·합성 일치 mask만 기록한다.

```sh
pnpm --filter @ldb/desktop capture:fixture:build
pnpm --filter @ldb/desktop capture:fixture
node apps/desktop/scripts/auth-capture-fixture/post-exit-check.mjs --media
```

수동 실행과 자동 media 실행을 같은 profile/process에서 병렬 수행하지 않는다. `--media`는 기존 smoke와 종료 뒤 process/profile 확인을 포함한다. 자동 smoke의 실제 stream/OCR·접수 증거와 화면의 검색 결과·버튼 관측은 구분해 기록한다. 실제 Electron 실행 전 준비만 완료한 상태를 native PASS로 표현하지 않는다.

## 검증 경계

```sh
pnpm --filter @ldb/desktop exec vitest run src/backend/search src/backend/capture src/preload src/frontend/src/search src/frontend/src/capture scripts/auth-capture-fixture
pnpm --filter @ldb/desktop run --sequential '/^(test|lint|build)$/'
git diff --check
```

일반 tests는 API·DB·native media를 실행하지 않는다. 실제 #125 API·disposable DB 소비 검증은 `apps/desktop/scripts/search-server-integration/README.md`의 별도 command와 격리를 따른다. 이는 Desktop HTTP 클라이언트 소비 검증이며 auth waiter·slot·IPC·renderer·실제 stream/OCR 성공을 대신하지 않는다. 최종 head의 unit/build·독립 review·실제 UI/media·서버 검증 결과는 Issue #144와 PR #149에서 관리한다.

## 검색 UI 전용 native smoke

기존 media smoke와 별도로 아래 command를 사용한다. 준비 build 뒤 Parent가 한 번 실행하며 같은 fixture의 수동 실행과 병렬로 사용하지 않는다.

```sh
pnpm --filter @ldb/desktop capture:fixture:build
node apps/desktop/scripts/auth-capture-fixture/post-exit-check.mjs --search
```

직접 launcher 경로는 `pnpm --filter @ldb/desktop capture:fixture:search`다. 기존 media/OCR/deny 모드와 기준은 유지한다. 새 모드는 실제 App·preload·main, 고정 synthetic source의 native stream과 실제 OCR를 사용한다. HTTP는 기존 memory-only 합성 transport이며 실제 API/provider에 접근하지 않는다.

`search-smoke.ts`는 0건 표시, 두 실패·pending·429의 동시 상태, 슬롯별 수동 retry 독립성, 15초 timeout, 429 양의 대기 중 disabled와 같은 실패의 만료 후 버튼 활성화, 자동 GET 부재, pending 중 logout 정리와 재로그인 후 새 source/Start를 관측한다. 네 합성 응답의 HTTP 도착 순서는 슬롯 번호 계약으로 취급하지 않고 실제 상태에서 대상 슬롯을 찾는다. 기존 로그인·source 선택·resource 관측 helper는 `actions.ts`에서 공유한다.

`search-observation.ts`는 기존 read API와 실제 DOM의 문구·버튼·후보 field를 별도로 읽는다. Capture/request 식별자는 실행 중 전후 비교에만 사용하며 원문 DOM·nickname·source ID는 로그에 남기지 않는다. 최종 search evidence는 관측한 mask·boolean·요청/abort counter로 구성한다. Post-exit wrapper는 exact evidence, child 성공, native 거절/미처리 오류 부재, process group 종료와 profile 부재를 함께 요구한다. 실패 시 고정 단계만 전달한다.

시간 제한은 새 모드에만 fixture 180초·launcher 210초·post-exit 240초를 적용한다. 네 capture 시작과 두 로그인, 동시에 진행하는 15초/5초 대기 및 cleanup의 전체 상한이며 완료 시간 보장은 아니다. 각 바깥 계층에 종료·정리 여유 30초를 둔다. 기존 모드는 90/120/150초, 제품 검색 예산은 15초를 유지한다.

소유 window의 640/1100 content 폭과 app-scoped light/dark 전환은 별도 `layout evidence`의 표본 수·가로 overflow 수·theme 불일치 수로 기록한다. 이 보조 관측을 핵심 검색 PASS나 공식 시각 기준 비교의 성공으로 합치지 않는다. OS 설정은 변경하지 않는다. 실제 Tab/Shift+Tab/Return/Space와 focus/loading의 수동 관측은 별도 evidence이며 이 자동화는 native keyboard 검증을 대신하지 않는다. Reduced-motion·픽셀 비교·다른 OS는 이 모드에서 검증하지 않는다. Source/test/build 성공과 실제 native 실행 결과는 Issue/PR에서 구분해 기록한다.
