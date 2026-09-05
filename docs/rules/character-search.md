---
type: rule
status: active
enforcement: approval-required
scope: apps/api character search
last-reviewed: 2026-09-05
rationale: 검색 입력·응답·실패·호출 제한을 후속 구현자가 추측하지 않게 한다.
evidence: "PR #42 검색 승인: https://github.com/blahaj94/ldb/pull/42#issuecomment-5550598698 ; PR #48 인증 통합 승인: https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519"
exceptions: 미확인 외부 규격과 새 정책은 사용자 결정 없이 구현하지 않는다.
review-after: 검색 adapter 첫 validation 완료 또는 네오플 공식 규격 변경 시
---

# Character Search Contract

이 문서는 [PR #42의 사용자 승인](https://github.com/blahaj94/ldb/pull/42#issuecomment-5550598698)을 반영한 Rule이다. 요청·응답·오류·deadline과 code point 입력 정책, 단일 process memory quota 및 명시된 한계가 승인 범위다. 인증/session 통합 규격은 PR #48에서 승인됐으며 아래 Authentication activity contract가 canonical Rule을 연결한다. 검색 결과 저장·캐싱, OCR 보정, 인증·DB 구현과 전체 서비스 한도는 이 문서의 범위 밖이다. 구현은 해당 Execution Issue와 [`change-control.md`](change-control.md)를 따른다.

## 요청과 성공 응답

`GET /characters`는 로그인한 사용자의 검색 query를 검증하고 `GET https://api.neople.co.kr/df/servers/:serverId/characters`를 한 번 호출한다. `characterName`은 필수 2~12자, `serverId` 생략 시 `all`, `limit` 생략 시 10이며 정수 1~200을 허용한다. Upstream `wordType=full`은 서버가 고정하며 pagination·직업 filter는 노출하지 않는다. [네오플 02. 캐릭터 검색](https://developers.neople.co.kr/contents/apiDocs/df)

- 기본값은 생략에만 적용한다. Empty value·검색어 앞뒤 공백·정수의 십진 숫자 표기가 아닌 `limit`·중복/배열/객체 query·미정의 key는 `400 INVALID_SEARCH_QUERY`이며 upstream을 호출하지 않는다.
- URL decoding 외에 trim·OCR 보정·대소문자 변경·Unicode 정규화를 하지 않는다.
- 성공 HTTP는 200이며 body는 `{"rows":[...]}`다. 결과 없음은 `{"rows":[]}`다. 전체 검증을 통과한 후보를 upstream 순서 그대로 반환하고, 각 row에는 아래 다섯 field만 넣는다.

| Field | 검증·반환 규격 |
| --- | --- |
| `characterId`, `characterName`, `serverId` | 필수 string. 빈 문자열·공백뿐인 값은 실패. 값은 그대로 유지하며 요청 검색어 길이나 별도 ID format을 적용하지 않음. |
| `serverName` | 우리 server map으로 생성한 string. 미등록 응답 ID는 후보·ID를 유지하고 null. Upstream `serverName`은 사용하지 않음. |
| `fame` | 유한한 JSON number는 0을 포함해 그대로 유지. null·누락은 null. 문자열·boolean·object·array는 실패. 음수·소수에 별도 제약을 추가하지 않음. |

Top-level은 null·array가 아닌 JSON object이고 `rows`는 array여야 한다. 모든 row도 null·array가 아닌 object여야 한다. 후보 하나라도 invalid하면 `502 NEOPLE_API_ERROR`로 **전체 실패**한다. 일부 후보만 제외하거나 숫자 문자열을 변환하지 않는다. 알려지지 않은 추가 field는 무시한다. `fame` 추가는 [공식 공지](https://developers.neople.co.kr/contents/notice/view/214)로 확인했지만 null·누락의 실제 발생 여부는 확인하지 않았으며 위 처리는 프로젝트 정책이다.

## Server map

요청 검증과 응답 `serverName`에 하나의 map을 사용한다. `all`은 요청의 별도 허용 값이며 실제 서버명 map에 넣지 않는다. 요청 `serverId`는 대소문자를 구분한다. 아래는 [공식 공통 가이드](https://developers.neople.co.kr/contents/guide/pages/all)에서 확인한 전체 서버 map이다.

| ID | 이름 | ID | 이름 |
| --- | --- | --- | --- |
| `anton` | 안톤 | `bakal` | 바칼 |
| `cain` | 카인 | `casillas` | 카시야스 |
| `diregie` | 디레지에 | `hilder` | 힐더 |
| `prey` | 프레이 | `siroco` | 시로코 |

미지원 요청 ID는 400이고 비어 있지 않은 미등록 **응답** ID는 정상이다. 예를 들어 응답 `serverId: "future-server"` 또는 `"all"`은 유지하고 `serverName: null`로 반환한다. Map 변경은 공식 규격을 확인한 별도 변경으로 검토한다.

## Raw query 판별

Framework의 object 변환·숫자 coercion 전에 original request URL의 `?` 이후 원본 query를 검사한다. Express가 만든 `req.query`만으로 중복 여부를 판단하지 않는다.

1. Raw query를 `&`로 나누고 각 component의 첫 `=`만 key/value 경계로 사용한다. `=` 없는 key는 empty value다. 비어 있는 component(`&&`, 마지막 `&`)도 잘못된 입력이다.
2. Key와 value에서 `+`를 space로 처리하고 percent-encoded UTF-8을 정확히 한 번 decode한다. 잘못된 `%` escape나 유효하지 않은 UTF-8은 400이다. `URLSearchParams`의 관대한 오류 복구 결과만 사용하지 않는다.
3. Decode한 key는 정확히 `characterName`, `serverId`, `limit` 중 하나여야 하며 각각 최대 한 번이다. `limit`와 `%6Cimit`도 중복이다. `limit[]`, `limit[0]`, `characterName[x]`와 encode된 bracket key는 허용 key가 아니므로 400이다. JSON/object로 value를 재해석하지 않는다.
4. Decode한 값에 확정 규칙을 적용한다. `characterName !== characterName.trim()`이면 400이며 공백 판별은 ECMAScript `trim`을 사용한다. 내부 공백은 별도 금지하지 않는다. `serverId`도 trim·case 변환 없이 map 또는 `all`과 비교한다.
5. `limit`는 ASCII `/^[0-9]+$/`와 숫자 범위 1~200을 모두 만족해야 한다. Leading zero는 십진 표기로 허용한다(`0010` → 10). 부호·소수점·지수·앞뒤 공백·비ASCII 숫자는 400이다. `parseInt`의 부분 성공은 사용하지 않는다.

Literal string value가 `[]`처럼 보이는 것만으로 배열로 변환하지 않는다. 배열·객체 전달 거절은 중복 key와 bracket key 등 query 구조에 적용한다. Decode 후 남은 `%xx`는 다시 decode하지 않는다. 통과한 값을 upstream URL에 만들 때 한 번 encode한다. 이 판별은 인증 guard와 별개로 순수 함수와 raw HTTP integration test에서 검증할 수 있어야 한다.

## 검색어 길이와 외부 규격 한계

**입력 정책은 decode 후 Unicode code point 수 2~12**다. JavaScript string iterator로 세며 정규화하지 않는다. `가나`는 2, `😀`는 1, `😀가`는 2, 분해된 `가`는 2다. 공백 검증은 길이와 별도로 적용한다.

공식 문서는 `full`의 2~12자와 UTF-8 전송을 안내하지만 UTF-16 code unit·code point·grapheme 중 무엇인지는 명시하지 않는다. 이 안을 네오플과 검증된 일치 규격으로 표현하지 않는다. [검색 규격](https://developers.neople.co.kr/contents/apiDocs/df), [UTF-8·검색 타입 FAQ](https://developers.neople.co.kr/contents/faq?category=2)

| 선택 | 영향 |
| --- | --- |
| Code point — 채택 | Supplementary character를 하나로 세며 결합 sequence는 여러 개. 별도 dependency 없음. |
| UTF-16 code unit — 미채택 대안 | JavaScript `length`와 같지만 supplementary character 하나가 둘로 셈. |
| Grapheme — 미채택 대안 | 화면상의 글자에 가까우나 Unicode segmentation과 외부 검색 제한이 같다고 보장할 수 없음. |

Code point 입력 정책과 외부 단위 미확인 한계는 승인됐다. 이는 네오플의 측정 단위를 실제로 확인했다는 뜻이 아니며, 다른 측정 정책으로 바꾸려면 별도 승인을 받는다. 우리 검증을 통과한 query를 네오플이 거절하는 경우 아래 502 mapping을 유지하고 임의로 길이·정규화 정책을 바꾸지 않는다. 이 결정은 credential 없는 runtime·adapter 검증을 막지 않는다.

## 정제된 오류

Body는 `{"error":{"code":"<CODE>","message":"<MESSAGE>"}}`만 사용한다. Upstream body·message·Key·내부 상세를 포함하지 않는다.

| 우리 HTTP / code | 고정 message |
| --- | --- |
| `400 INVALID_SEARCH_QUERY` | 검색 조건을 확인해 주세요. |
| `401 AUTHENTICATION_REQUIRED` | 로그인이 필요합니다. |
| `429 SEARCH_RATE_LIMITED` | 검색 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요. |
| `500 INTERNAL_SERVER_ERROR` | 서버 오류로 검색을 처리하지 못했습니다. |
| `502 NEOPLE_API_ERROR` | 캐릭터 검색 중 오류가 발생했습니다. |
| `503 NEOPLE_UNAVAILABLE` | 현재 캐릭터 검색을 이용할 수 없습니다. 잠시 후 다시 시도해 주세요. |
| `504 NEOPLE_TIMEOUT` | 캐릭터 검색 응답 시간이 초과됐습니다. 다시 시도해 주세요. |

| 순서 | 조건 | 결과 |
| --- | --- | --- |
| Local | 우리 query 오류 / 로그인 정보 누락·무효·만료 / 계정 제한 초과 | 각각 400 / 401 / 429; upstream 없음. 이 셋의 통합 우선순위는 아래 승인된 인증 contract. |
| Local | 우리 설정·내부 오류 | 500; upstream 여부는 오류 발생 지점에 따름. |
| Upstream 1 | 호출 deadline 도달 | 504; 도착이 늦은 response나 code로 결과를 바꾸지 않음. |
| Upstream 2 | 식별한 `API000`, `API003`, `API004`, `API005` | Upstream HTTP와 관계없이 500. |
| Upstream 3 | 식별한 `API002`, `API008`, `DNF980` | Upstream HTTP와 관계없이 503. |
| Upstream 4 | 식별한 `API901`, `DNF901`, `DNF000`, `API006`, `API007`, `API900`, `API999`, `DNF999` | Upstream HTTP와 관계없이 502. |
| Upstream 5 | 위 분류가 없는 실패이며 upstream HTTP 429 또는 503 | 503. |
| Upstream 6 | 그 밖의 upstream 실패·통신 실패·JSON/응답 검증 실패 | 502. |

네오플 error code는 exact string `error.code`로 식별하며 `error.status`가 HTTP나 알려진 code를 덮어쓰지 않는 안이다. 표에 없는 code는 미분류 fallback을 적용한다. 알려진 code가 HTTP 2xx와 함께 와도 code 분류를 우선하고, `error`가 존재하는 body는 `rows`와 함께 와도 성공으로 처리하지 않는 안이다. 비JSON 또는 malformed error의 code를 추정하지 않는다. 식별 가능한 code가 없으면 실제 HTTP fallback을 사용하며 2xx body가 유효한 `rows`일 때만 성공한다.

공식 [오류 코드 표](https://developers.neople.co.kr/contents/guide/pages/code)의 Key/IP 사용량 초과는 HTTP 400이다. 이를 우리 입력 400으로 복사하지 않는다. Key 오류의 upstream 401도 우리 로그인 401로 바꾸지 않는다. `API901` + HTTP 503은 알려진 code가 우선하여 502, 미분류 code + HTTP 503은 fallback 503이다.

## Deadline과 adapter

네오플 호출 대기는 최대 5초, timeout은 504, 서버 자동 retry는 0회다. 세부 규칙은 transport 호출 직전부터 headers와 전체 body 수신·검증 완료까지 하나의 5,000ms deadline을 적용하는 것이다. 완료 판정 시각이 deadline **이상**이면 timeout이다. Headers만 빨리 도착해도 body가 늦으면 성공하지 않는다.

Node 내장 `fetch`와 abort signal로 body 수신까지 취소하고 timer를 정리한다. Deadline 이전 network/body read 실패는 502, deadline에 따른 abort는 504로 구분한다. Redirect는 따라가지 않는 안이며 3xx는 위 fallback 오류다. 늦게 끝난 작업으로 추가 응답하거나 retry하지 않는다. Event loop 지연 때문에 실제 HTTP write가 정확히 5,000ms 안에 일어난다고 보장하지 않는다.

순수 adapter는 **검증된 검색 값 → URL 구성·transport 1회·전체 응답 검증/projection 또는 정제된 오류**만 담당한다. 인증 guard, user/session, DB, 활동 기록과 rate-limit 저장소를 import하지 않는다. Transport·clock/abort 경계는 test에서 fake로 제어할 수 있어야 하며 loopback upstream으로 실제 HTTP encoding·status·body·취소를 함께 검증한다. 운영 upstream origin은 고정하고 요청 query가 URL/host를 지정하지 못하게 한다. Loopback origin과 fake credential은 test 주입에만 사용한다. [Node fetch](https://nodejs.org/docs/latest-v24.x/api/globals.html#fetch)

## 계정당 제한

**논의 확정 수치**는 계정당 최근 60초 최대 10회, 기기·검색 조건 합산, 초과 시 upstream 없이 429와 `Retry-After`다. 아래 차감·시간·동시성·저장 범위도 승인된 정책이다.

- 검증된 내부 account ID로 합산한다. 요청이 보낸 account/session ID나 IP를 계정의 대체값으로 사용하지 않는다.
- Query 검증을 통과하고 호출에 필요한 설정이 유효한 뒤, upstream 호출 직전에 1회를 원자적으로 예약한다. 성공·0건·upstream 실패·timeout 모두 유지하고 환불하지 않는다. 잘못된 query·인증 실패·제한 거절·호출 전 설정 실패는 차감하지 않는다.
- 서버가 정한 단조 clock의 예약 시각 `t`에서 `(t - 60,000ms, t]`에 든 이전 예약만 센다. 정확히 60초 전 예약은 만료다. 10개 미만이면 같은 원자 연산 안에서 새 시각을 추가하고 즉시 호출한다. Quota가 풀리기를 기다리는 대기열은 없다. 내부 admission 대기는 아래 승인된 통합 contract를 따른다.
- 이미 10개면 `Retry-After = max(1, ceil((oldest + 60,000 - t) / 1,000))`인 십진 정수 초를 header에 보낸다. 429는 새 예약을 추가하거나 기존 시각을 갱신하지 않는다.
- 같은 계정의 prune·count·reserve 사이에 다른 요청이 끼어들지 않게 한다. 같은 시각의 11개 동시 요청은 최대 10개만 통과하고 1개는 429다. 서로 다른 계정은 독립적이다. 초과 요청 자체가 제한 창을 연장하지 않는다.

**승인된 저장 범위:** 단일 Node process의 memory에 최근 예약만 유지하고 만료 entry를 정리한다. 여러 기기는 동일 process의 account key로 합산한다. 재시작 시 제한 이력이 사라져 60초 안에 추가 호출이 허용될 수 있고, 여러 process/replica에서는 10회 보장이 성립하지 않는다. 승인된 memory 방식은 위 단일 process·재시작 한계 안에서만 사용한다. 대안은 공유 저장소의 원자 예약이지만 새 dependency·운영 state/DB 계약이 필요하므로 별도 설계 대상이다. 검색 결과를 저장하는 안은 아니다.

**승인된 인증 통합:** 인증 실패와 invalid query가 겹치면 401, 인증된 invalid query와 계정 제한이 겹치면 400이다. Query/config 검증 이후 admission capacity 확인·활동 commit·계정 예약·upstream의 상세 순서와 session 만료·잔여 JWT·DB 실패는 아래 canonical contract를 따른다. 전체 서비스 limiter가 추가되면 계정 예약과의 순서·환불 여부는 별도 결정한다.

### Authentication activity contract

[PR #48 사용자 승인](https://github.com/blahaj94/ldb/pull/48#issuecomment-5551469519)을 반영한 [`auth-activity.md`](auth-activity.md)가 상세 contract다. Account admission 직렬화·DB 활동 commit 후 기존 quota를 예약하는 순서와 총 2초 내부 대기, 정상 DB의 revoked/없는 session은 residual 검색·활동 0, DB 장애는 기존 검색 500·upstream/예약 0이 승인됐다. JWT/session 시간은 [`auth-session.md`](auth-session.md)를 따른다.

**Quota 대기열 금지와 총 2초 내부 admission 대기 허용**을 구분한다. 기존 예약 window·시각·즉시 upstream·무환불·단일 process 한계를 유지한다. 이 승인은 현재 인증·DB 통합 구현이나 검증 성공을 뜻하지 않으며 사용자의 구현 금지 조건과 별도 미결정 gate를 유지한다.

## 간결한 경계 예시

아래는 승인된 검색 계약의 기대값이다. Upstream 횟수는 유효한 인증·설정과 여유 quota를 전제로 한다.

| 사례 | HTTP / body의 핵심 | Upstream |
| --- | --- | --- |
| `characterName=가나`, 옵션 생략, 빈 결과 | 200 / `{"rows":[]}`, upstream `all`, 10, `full` | 1 |
| `characterName` 없음·1자·13자·앞뒤 공백 | 400 / `INVALID_SEARCH_QUERY` | 0 |
| `serverId=`·`limit=`·`limit=1e2`·미지원 서버 | 400 / `INVALID_SEARCH_QUERY` | 0 |
| 중복·encoded 중복·bracket key·unknown key·깨진 escape | 400 / `INVALID_SEARCH_QUERY` | 0 |
| `limit=0001`·`limit=200` | 200 / 검증된 rows, upstream limit 1·200 | 각 1 |
| 응답 `fame: 0` / null / 누락 | 200 / 각각 0 / null / null | 각 1 |
| 정상 후보와 `fame: "0"` 후보 혼합 | 502 / `NEOPLE_API_ERROR`, 부분 rows 없음 | 1 |
| 정상 미등록 응답 서버 | 200 / ID 유지, `serverName: null` | 1 |
| `API003` + HTTP 401 / `API002` + HTTP 400 | 500 / `INTERNAL_SERVER_ERROR`, 503 / `NEOPLE_UNAVAILABLE` | 각 1 |
| 5,000ms 도달, body 미완료 | 504 / `NEOPLE_TIMEOUT`, retry 없음 | 1 |
| 예약 10개가 t=0, 요청 t=59,999ms | 429 / `SEARCH_RATE_LIMITED`, `Retry-After: 1` | 0 |
| 같은 상태, 요청 t=60,000ms | 허용 후 upstream 결과, 이전 10개 만료 | 1 |

상세 acceptance matrix와 실행 evidence는 해당 Execution Issue/PR에 둔다. Runtime 도구와 실제 실행 계획은 [`api-runtime.md`](api-runtime.md), Red→Green 순서는 [`testing.md`](testing.md)를 따른다. 길이·raw decoding·deadline·quota 정책과 승인된 인증 통합의 변경을 후속 구현자의 일반 선택으로 숨기지 않는다.
