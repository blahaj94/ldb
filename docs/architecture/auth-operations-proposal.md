---
type: rule
status: proposed
enforcement: approval-required
scope: self-managed authentication storage, deployment and recovery operations
last-reviewed: 2026-09-07
rationale: 인증 DB를 복원해도 확정된 삭제와 사본의 보관 기한을 되돌리지 않는 운영 경계를 제안한다.
evidence: "Issue #130: https://github.com/blahaj94/ldb/issues/130 ; D1–D5 승인: https://github.com/blahaj94/ldb/pull/72#issuecomment-5557976162"
exceptions: 설계안이며 환경 확보·dependency 설치·제품 및 인프라 구현·실제 복원 authority가 아니다.
review-after: 사용자 구성 선택, 저장소·권한·clock 변경 또는 최초 장애/복원 검증 시
---

# 인증·탈퇴 운영 구성 제안

추천안은 **API와 auth DB, 삭제 journal, 독립 최신값 저장소를 세 관리 경계로 분리**한다. Auth DB가 과거로 돌아가도 현재 journal로 삭제를 다시 적용하고, journal까지 되돌아가면 독립 최신값과의 불일치로 복원을 중단한다. 세 번째 저장소를 이 문서에서는 witness라고 부른다. 외부 백업 서비스를 사용하지 않는 사용자 소유 구성이다.

[D1–D5](../rules/auth-withdrawal-proposal.md)는 이미 승인됐다. 이 제안이 새로 선택하는 것은 장비·저장소·권한·실행 책임과 검증 방법이며 정책의 수치·취소 불가 확정점·복원 순서는 바꾸지 않는다. [운영 검증 계획](auth-operations-validation-proposal.md)은 같은 제안의 나머지 부분이다. 작성 완료, Draft PR 승인·merge, 환경 확보, 구현, 실제 복원 검증은 각각 별개 결과다.

## 구성과 대안

```text
인터넷 ── HTTPS ingress / 유지보수 gate ── A: 단일 API process
                                               │ 사설 DB 연결
                                          A: auth PostgreSQL
                                               │ 암호화 dump
                                               ▼
                                       B: 별도 backup volume
API 탈퇴 executor ── 상호 TLS ── B: 단일 control 조정 process
                                    │ B transaction 유지 + C 별도 연결
                                    ├── B: journal/control PostgreSQL
                                    └── C: 독립 witness PostgreSQL
                                  현재·직전 checkpoint + 진행 표식
복구 담당 ── 격리 network ── 별도 restore DB / 검증 후 cutover
```

A/B/C는 논리 이름이다. 실제 장비·주소·domain·TLS 인증서·운영자는 아직 확보됐다고 확인하지 않았다. 아래 모든 운영 배치는 승인 대상이며 [auth-runtime.md](../rules/auth-runtime.md)의 local Docker 검증용 image/volume 승인을 운영 승인으로 확대하지 않는다.

| 선택 | 배치와 비용 | 내구성·운영 부담 |
| --- | --- | --- |
| **추천: 물리 3대** | A에 API/auth DB, B에 journal과 별도 암호화 backup disk, C에 작은 witness. 별도 전원·disk·관리 자격을 확보한다. C의 용량은 작지만 장비·patch·관측 대상이 늘어난다. | A 손실이나 B의 과거 snapshot을 C와 구분할 수 있다. B payload 전부 또는 C 신뢰를 잃으면 서비스 재개가 불가하다. 자동 failover/HA를 약속하지 않는다. |
| **대안: 물리 2대** | A에 API/auth DB와 별도 witness process·전용 disk·OS/DB 계정, B에 journal과 backup disk. A auth volume만 복원할 권한을 분리한다. | 같은 protocol과 중단 조건을 유지한다. A 전체 장비 손실·전체 image 복원은 witness 신뢰도 잃으므로 가용성이 더 낮다. A의 root가 두 경계를 관리하는 위험을 수용하고 전체 host 복원 경로를 제거해야 한다. |

같은 auth dump 안 journal, 같은 snapshot 안 journal+최신 checkpoint, journal에 대한 비동기 checkpoint 후처리만 있는 안은 채택하지 않는다. C를 없애고 B만 신뢰하면 B와 head의 조용한 공동 rollback을 감지할 수 없어 이번 대안의 동등한 안전성을 제공하지 않는다.

### 저장소 선택과 비용

B와 C도 PostgreSQL 18의 transaction·row lock·WAL을 재사용하는 안을 추천한다. B에는 기존 Node/pg 기반의 **단일 control 조정 process**를 별도 서비스로 제안한다. API의 상호 TLS 신원을 확인하고, B transaction/연결을 유지한 채 C의 별도 연결로 예약·완료를 호출하는 주체다. PostgreSQL 저장 함수 자체가 다른 DB에 접속하는 것으로 가정하지 않는다.

이 안은 승인된 driver version을 바꾸지는 않지만 PostgreSQL·Node/pg의 새 운영 역할, 내부 인증 연결과 저장 연산 구현은 승인 대상이다. 조정 process는 원자적인 B/C 함수 호출·불명 결과 판정만 맡고 generation 검사·권한·잠금·멱등성은 저장소가 강제한다. 별도 합의 알고리즘·범용 journal library를 직접 만들지 않으며, 이 작은 protocol도 PostgreSQL만 설치하면 생기는 것은 아니다. 구현 규모가 커지면 [dependency 비용 기준](../rules/change-control.md#dependency-선택과-비용)에 따라 다시 비교한다.

Backup은 소규모 DB의 일별 `pg_dump`를 출발점으로 제안한다. 데이터 증가에 따른 dump/restore 시간과 잠금 영향을 검증한 뒤 사용하며 PITR·WAL archive·standby는 이번 최소안에 추가하지 않는다. 원문 dump를 disk에 먼저 쓰지 않고 암호화 stream으로 전달한다. 파일 암호화는 유지보수되는 `age` CLI를 후보로 제안한다. 직접 암호화 format을 만드는 비용을 피하지만 새 운영 dependency·exact version·binary 검증·복구키 관리의 승인이 필요하다. 기존 OS의 검증된 암호화 volume 안에서만 dump를 보관하는 대안은 dependency가 줄지만 외부로 파일이 복사될 때 암호화 경계가 사라지므로 모든 복사 경로를 더 좁혀야 한다. 이번 문서는 설치나 key 생성을 수행하지 않는다.

## 저장과 권한

| 주체 / 저장물 | 허용 책임 | 금지·분리 경계 |
| --- | --- | --- |
| API 실행 계정 / A auth DB | 승인된 API 조회·transaction. 단일 process가 현 generation의 탈퇴 executor를 가진다. | DDL·role 변경·backup volume·B/C 원시 table 쓰기·host 관리 권한 없음. |
| 현재 journal writer / B 조정 process | 인증한 API caller와 자신의 DB 로그인 identity를 현 generation에 결합한 제한된 append·완료 기록 함수 실행. | Caller가 현 generation 숫자를 읽어 제출해도 옛 identity는 거절. 직접 INSERT/UPDATE/DELETE/TRUNCATE/DDL·owner 상속 없음. |
| Witness writer / B 조정 process→C | C 전용 DB 로그인으로 현재 writer identity에 결합된 reservation·완료 CAS. 개인정보 없는 head와 진행 표식만 저장. | 일반 API credential로 접속 불가. B 운영체제/DB owner가 C owner나 disk에 접근하지 못함. |
| Backup 실행 계정 / A→B backup volume | 명시된 auth DB의 필요한 read 권한과 등록된 사본 경로 쓰기. 공개 암호화 recipient만 보유. | App schema 변경·journal/anchor 변경·복호화키·일반 shell/임의 copy·host snapshot 권한 없음. |
| 배포 담당 / Migration 계정 | 승인된 compiled JavaScript Migration을 **배포마다 단 한 명이 명시 실행**. 적용 목록·target DB·결과 확인. | API 시작 시 Migration 없음. API 계정에 DDL 부여·동시 실행·운영 destructive down 없음. |
| 복구 담당 / restore DB | 유지보수 gate, writer 교체 요청, 별도 DB restore·삭제 재적용·검증·cutover·scratch 폐기. | Auth 복원 권한으로 B/C 복원·head 초기화·generation 감소·만료본 승격 불가. |
| Control 관리 담당 / B, 독립 witness 관리 담당 / C | 승인된 schema·계정·장비 유지보수와 continuity 확인. C 관리 자격은 일상 배포/복구 계정과 분리. | Root/DB superuser를 앱이나 backup job에 배포하지 않음. C를 빈 저장소/옛 image로 바꾸고 현 lineage를 계속 쓰지 않음. |
| Secret 관리 담당 / DB 밖 파일·복구키 | 서비스별 최소 secret을 읽기 전용 주입, version·교체·폐기와 복구키 사본 목록 관리. | Source·image layer·dump·journal·일반 log에 private key/provider credential 없음. |

모든 역할은 책임 제안이며 사람이나 다른 Issue에 배정한 것이 아니다. 실제 담당자와 긴급 접근자를 정하기 전 운영 준비 완료로 표시하지 않는다. B/C의 table owner는 별도 `NOLOGIN` 역할로 두고 runtime 역할의 membership을 막는다. 제한 함수는 신뢰된 schema의 고정 `search_path`, 명시적 객체 이름, `PUBLIC EXECUTE` 회수와 필요한 역할만의 권한을 갖춰야 한다. 슈퍼유저를 공격자로부터 보호하는 기능이라고 주장하지 않는다.

### Network·volume·설정 인계

- 공개 port는 HTTPS ingress만 둔다. API는 사설 interface, auth DB는 API·명시 Migration·backup/복구 network만 허용한다. B/C는 공개 listen 없이 allowlist와 서버 신원 검증 TLS로 연결한다. Ingress 우회 주소도 함께 차단할 수 있어야 한다.
- A auth data, B control data/WAL, B backup, C witness data는 별도 volume이다. Container에는 자기 volume과 secret만 mount하고 host disk·Docker socket·다른 서비스 root를 주지 않는다. 단순 volume 이름 차이를 물리 장애 분리로 세지 않는다.
- [#125의 PR #128 제안](https://github.com/blahaj94/ldb/pull/128)은 `a8022ad`에서 `AUTH_CONFIG_FILE`의 절대 경로 단일 JSON, 시작 때 한 번 읽기·교체 시 재시작, 역사적 `(version, reference)`의 정확한 key mapping을 제안한다. 그 schema를 여기서 복제하거나 확정하지 않는다. 승인 전에는 운영 입력 후보이며 변경되면 인계만 다시 맞춘다.
- 기존 `DB_*`, `PORT`, `NEOPLE_API_KEY`, 필수 설정의 listen 전 정제 검증, 자동 Migration 없음은 기존 계약을 따른다. 운영 배포는 선택된 입력 형태에 맞춰 secret file을 읽기 전용으로 주입하고 원자적 파일 교체 후 재시작한다. Secret 내용·환경 전체·인증 포함 DSN을 관측 evidence에 남기지 않는다.
- JWT/PKCE/fence key와 DB·provider credential, backup 복구키를 분리한다. 정상 key 교체의 역사적 verify/decrypt key 보존은 [session](../rules/auth-session.md)·[DB](../rules/auth-database.md) Rule대로 처리한다. 복원 때는 옛 key를 secret file에 다시 포함하지 않는다.
- 운영 조정은 ingress 중지→executor 중지→진행 요청 종료/취소→DB 연결 종료를 확인한다. PR #128의 `app.close()` 검색 취소 뒤 DB 종료 제안과 접합하되, #125가 이번 witness·복원 gate를 구현한다고 요구하지 않는다. 강제 종료가 필요하면 journal 판정은 저장소에서 계속 확인한다.

## Journal 최신성과 writer 교체

### 신뢰 경계와 다루는 장애

B는 UUID를 포함한 최소 journal과 backup inventory를, C는 개인정보 없는 현재·직전 `(lineage, generation, sequence, digest)` 및 단일 진행 표식을 보유한다. Digest는 retained journal·compaction 경계·inventory의 일관된 상태를 결합한다. 현재 C 값이 B 밖에 있으므로 B의 정상 checksum을 가진 옛 snapshot도 불일치로 감지한다. Digest 자체는 최신성 증명이 아니다.

C는 **되복원하지 않는 신뢰 authority**다. 별도 물리 disk의 bare-metal 저장소를 제안하며 VM/image/filesystem snapshot·PITR·backup import·이전 cluster 승격 경로를 제공하지 않는다. 복구 계정에는 C SSH/root/DB owner/block device 접근이 없고, C의 저장 함수는 head/generation 감소·lineage 재초기화를 거절한다. C root는 별도 관리자가 통제하며 장비·disk identity, 허용된 계정/함수, snapshot 부재와 유지보수 이력을 서비스 시작·복구·관리 변경 시 대조한다. 대안 구성에서는 A root와 C disk의 공동 권한이 추가 신뢰 가정이다.

보장 범위는 A auth restore/손실, B journal의 누락·부분 손상·단독 snapshot rollback, process crash·응답 유실·network 단절·이전 writer의 재접속이다. C의 silent rollback을 감지하는 더 바깥의 anchor는 이 최소안에 없다. **C 관리자 침해, C disk의 조용한 clone 교체와 B/C의 일치하는 공동 rewind를 cryptography로 탐지한다고 주장하지 않는다.** 이를 하지 않는 독립 관리/장비 경계가 승인·검증돼야 한다. C 초기화·disk 교체·전체 image 복구·관리권 침해 또는 continuity 증거 불명은 이 가정의 상실이며, 빈 C를 다시 만들어 기존 auth를 공개하지 않는다. 해당 위협까지 견뎌야 한다면 장비 기반 단조 anchor 등 다른 설계가 선행돼야 한다.

B/C는 `fsync=on`, `full_page_writes=on`, 각 변경 transaction의 `synchronous_commit=on`을 요구하는 안이다. 비동기 성공·unlogged journal·메모리 ack는 허용하지 않는다. Storage가 flush를 실제 안정 매체까지 보장하는지 전원 손실 시험과 장비 근거가 필요하다. Mirroring/UPS는 권장 장비 후보이지만 fsync의 대체나 전체 손실 복구 증명이 아니다.

### Durable append와 crash 판정

다음은 구현할 protocol의 제안이며 D1의 확정점은 **B의 journal intent가 durable commit된 순간** 그대로다. C 완료나 HTTP 응답이 그 시점을 늦추지 않는다. 새 intent와 inventory/compaction/head 변경은 한 번에 하나만 진행한다.

1. 조정 process가 B 연결에서 transaction을 시작하고 저장 함수가 control row를 잠가 session identity·인증된 API caller binding·generation을 검사한다. 잠금을 transaction 끝까지 유지하며 deletionId 중복은 같은 payload만 허용한다. 새로운 연속 sequence와 payload digest를 정한다. PostgreSQL의 gap 가능한 sequence 값만으로 journal의 연속성을 판단하지 않는다.
2. 조정 process가 B 연결과 잠금을 유지하며 C의 별도 연결을 호출한다. B commit **전에** C가 직전 head에 대한 CAS로 다음 generation/sequence/digest의 reservation을 durable 기록한다. C 예약이 확인되기 전 B는 intent를 commit하지 않는다. C 응답 유실이면 같은 reservation을 조회하고, 불명인 채 새 연산을 시작하지 않는다.
3. B가 최소 intent·현 checkpoint를 같은 transaction으로 durable commit한다. 여기서 탈퇴는 취소 불가다. 이후 C에 완료 기록을 요청하고, B와 C의 head 일치 확인 뒤 결과를 응답한다. C 완료 실패·ack 유실도 B에 있는 intent를 취소하거나 user를 active로 되돌릴 근거가 아니다.
4. Crash 뒤 C가 완료이고 B가 일치하면 같은 ID 결과를 사용한다. C가 pending이고 B의 일치하는 intent가 있으면 현재 복구 주체가 C를 완료한다. B intent가 있는데 C의 예약/완료 근거가 없거나 다른 digest이면 protocol 위반·rollback 의심으로 중지한다.
5. **C pending인데 B intent가 없으면 부재를 확정한 것으로 보지 않는다.** 실제 commit 전 crash와 commit 뒤 B rewind를 구별할 수 없기 때문이다. Preparing을 유지하고 공개 복원을 막는다. 동일한 검증된 준비·payload를 보존한 정상 로컬 재개는 같은 deletionId append를 끝낼 수 있지만, 유실된 payload를 옛 auth backup에서 추측해 만들거나 reservation을 지워 취소하지 않는다. 안전하게 종결할 근거가 없으면 장기 중단이 이 최소안의 가용성 비용이다.

C와 B 사이의 두 번의 durable 기록이 추가 지연·장애 지점을 만든다. 이 비용을 줄이려고 C를 비동기 후처리로 바꾸지 않는다. API의 preparing·24시간 장애 대응과 이 protocol을 연결하는 검증이 필요하며, PostgreSQL 설정 확인만으로 이 결과를 PASS 처리하지 않는다.

### 저장소에서 이전 writer 차단

Append·완료·generation 교체는 각 저장소의 같은 control row를 잠근다. 허가된 DB session identity와 조정 process가 인증한 API 신원을 generation에 결합하고 새 generation은 새 역할·허용 신원으로만 사용한다. 기존 TLS 연결의 요청도 매번 이 binding을 검사한다. API가 지정한 정수 epoch만 검사하거나, 비밀번호/`CONNECT` 변경만 하는 것으로 fencing을 대신하지 않는다. 현재 조정 process의 올바른 protocol 실행은 신뢰 전제이며 그 process/현재 자격 자체의 침해까지 PostgreSQL 함수만으로 해결한다고 주장하지 않는다.

- Append가 먼저 B 잠금을 얻었다면 generation 변경은 그 transaction의 commit/rollback을 기다린다. 먼저 commit된 intent는 최종 journal에 포함한다. Generation 변경이 먼저면 이미 연결된 옛 writer의 append도 저장 함수에서 거절한다.
- 복구는 ingress·process·job을 중지하고 C에서 새 reservation을 차단하는 generation 전환을 먼저 완료한 뒤 B도 전환한다. 기존 C pending은 지우지 않는다. B 장벽까지 통과한 후 남은 pending/intent를 대조하고 C 완료를 복구 권한으로 종결한다. 양쪽 generation·head가 정합해질 때까지 새 writer를 시작하지 않는다.
- Timeout·잠금 대기·연결 종료 요청만으로 장벽 완료를 주장하지 않는다. 현재 generation의 durable 확인과 이전 transaction 부재를 확인한다. Auth DB도 이전 runtime/cleanup/Migration 역할의 재접속을 막고 기존 backend를 종료해 transaction rollback/종료를 확인한다. `max_prepared_transactions=0`인 최소안으로 숨은 prepared transaction을 만들지 않는다.
- 이미 외부 provider로 나간 revoke는 이 장벽으로 되돌리지 못한다. 기존 claim/epoch/deadline에 따라 `unknown`으로 수렴시키며 재호출하지 않는다. 늦은 callback·DB 결과는 이전 identity/epoch로 반영할 수 없다.

## Clock·사본 inventory·정리

Auth의 판정 시각은 [session Rule](../rules/auth-session.md#시간과-idle-만료)의 lock 뒤 fresh UTC whole-second다. 운영 clock은 A/B/C의 인증된 시간 동기화와 독립 관리 관측을 연결하는 안이다. 동기화 소스·최대 오차/불확실성·forward step 판단값·관측 간격은 실제 환경에서 선택하고 검증해야 한다. 미정값을 임의로 허용 leeway로 바꾸지 않는다.

각 시작/작업 전 동기화 상태, last trusted UTC와 process monotonic elapsed를 대조한다. 역행·재부팅 후 신뢰 상실·큰 전진/노드 간 불일치는 auth admission·backup 승격·journal compaction·복원 공개를 중지한다. Clock이 불명하면 오래된 사본을 새 시각으로 재등록하지 않는다. 만료 자격의 거절을 유지하되 물리 삭제 성공을 시간만으로 추정하지 않는다. Clock 확인 후 미뤄진 삭제를 우선한다.

Inventory는 B에 저장하고 C의 head에 결합해 rollback을 감지한다. 사본 생성 **전** 대상 경로/volume·소유자·snapshot ID·원 snapshot 시각·lineage·상태를 등록한다. Dump 시작 전 신뢰 시각을 origin으로 잡아 실제 snapshot보다 보수적으로 나이를 계산한다. 사본은 content digest·journal checkpoint를 함께 가지며, 복사·restore·re-backup은 원 snapshot 시각과 부모 lineage를 상속한다. 검증 후 새 lineage로 승격해도 원 사본의 age를 리셋하지 않는다.

Inventory 확인은 등록 table 조회로 끝내지 않는다. 허용된 모든 volume/object 경로와 host/volume snapshot 목록, DB cluster·복제 설정·WAL archive/slot·복구키 사본 목록을 실제 열거해 대조한다. 생성 주체는 등록된 목적지 외 쓰기/export 권한이 없어야 한다. 알 수 없는 사본이나 확인할 수 없는 저장소가 있으면 complete inventory라고 표시하지 않는다.

| 대상 | 운영 적용과 성공 증거 |
| --- | --- |
| 정상 auth cleanup | 시작 시 1회+하루 1회는 기존 정책. 실제 일일 시각은 UTC 03:00 후보. 별도 탈퇴 정리는 receipt/fence의 고정 TTL을 연장하지 않고 완료/만료 때 정리한다. |
| 성공 backup | UTC 03:15 일별 dump 후보. 성공본 최대 7개와 origin+7일 미만을 동시에 검사한다. 새 8번째 성공본 승격 전 오래된 성공본의 폐기를 확인한다. 신규 backup 실패가 만료본 보관 연장을 허용하지 않는다. |
| 실패·임시·이전 primary | 실패 dump는 즉시, scratch DB는 검증/실패 종료 때, cutover 뒤 옛 primary는 격리 후 폐기한다. 생성 중 partial file·decrypt 임시물·container volume·개발 복제본·OS snapshot·교체 disk까지 inventory 대상이다. 소유자와 원 age 없이 복사하지 않는다. |
| 만료본 | 원 snapshot deadline 전에 폐기를 시작할 여유 시간을 실제 최대 처리시간으로 정한다. Eligibility는 정확한 deadline부터 거절한다. Timer 실패·disk 불가로 잔여가 있으면 삭제 성공을 표시하지 않고 D4 장애 예외로 격리한다. |
| Journal compaction | 완료 확인+8일과 관련 모든 snapshot의 7일 초과·승인 목록 제외·실제 폐기를 함께 확인한 segment만 UUID를 제거한다. Pending intent나 폐기 미확인 사본이 참조하는 intent는 유지한다. C reservation→B compaction commit→C 완료로 바뀐 head를 확인한다. |
| Compaction의 물리 잔여 | B의 옛 segment·재작성 임시물·WAL·disk snapshot·복제본과 교체 매체를 함께 처리한다. SQL DELETE/VACUUM·파일 unlink만으로 매체 잔여 삭제를 증명하지 않는다. 선택 저장 매체의 폐기/암호키 파괴 절차와 모든 key 사본 제거를 검증해야 하며 불가능하면 D4 예외다. |
| 최소 evidence | Inventory는 원 snapshot+15일, 실패 dump/scratch evidence는 종료+8일, 운영 log는 7일 정책을 적용한다. C/B의 현재 checkpoint는 한 값, 직전은 최대 8일만 유지하며 무한 checkpoint history나 UUID 포함 옛 segment 사본을 만들지 않는다. |

### Backup 매체의 교체와 독립 폐기

공유 `age` recipient나 volume key는 파일별 폐기 경계가 아니다. Backup에는 **현 매체와 별도로 전체 sanitize할 수 있는 암호화 후보 매체를 번갈아 사용하는 방식**을 제안한다. 파일을 unlink하고 같은 매체를 계속 쓰는 것으로 만료본을 폐기했다고 표시하지 않는다. 새 dump·이관 임시물은 후보 매체에만 쓰므로 실패해도 현 매체의 유효 성공본을 함께 지울 필요가 없다. 독립 폐기가 가능한 매체 최소 2개, 전체 유효본을 복사할 용량·시간과 검증 가능한 sanitize가 추가 비용이다. 공유 recipient key를 파괴해 아직 유효한 성공본까지 읽을 수 없게 만드는 방법은 쓰지 않는다.

1. Backup 조정 담당이 다른 backup/이관 writer를 멈추고, 원 age가 유효한 성공본 중 보존할 집합과 폐기할 집합을 정한다. 새 dump가 있으면 최종 성공본 집합이 최대 7개가 되도록 정하며 이관 중 만료될 가능성도 확인한다. 새 dump가 없어도 만료본을 제거하는 교체를 수행한다.
2. B/C protocol로 원 매체·후보 매체·각 물리 copy·partial file의 생성/이관 중 상태를 먼저 durable 등록한다. 보존할 사본만 후보 매체로 복사하고 snapshot ID·원 snapshot 시각·부모 lineage·digest를 유지한다. 새 dump도 후보 매체에서 암호화하며 평문 임시물을 공유 매체에 쓰지 않는다.
3. 후보의 보존본 전부와 새 dump의 복구 가능성·digest·age를 격리 검증한다. **기존 성공본 수와 inventory의 물리 사본 수를 따로 관측**한다. 이관 중 source와 candidate copy를 모두 등록하고 각각 7일 age cap을 적용한다. 후보는 임시 이관물이며 원 매체 폐기와 inventory 확정 전에는 성공본 승격·공개 복원에 사용하지 않는다. 복사로 새 성공본을 추가하거나 기존 성공본의 상태만 바꿔 최대 7개 제한을 우회하지 않는다.
4. 전체 후보 검증 뒤 원 매체를 접근 차단하고 전체 sanitize해 만료본·이전 파일/WAL·partial 등 실제 잔여 제거를 확인한다. 그 증거 이후에만 B/C에서 원 매체/사본의 폐기와 후보의 현 매체 승격을 확정한다. 선택하지 않은 옛 성공본을 폐기한 증거 전 새 8번째 성공본을 승격하지 않는다. 원 age는 승격 후에도 유지한다.
5. 새 dump·복사·검증이 실패하면 즉시 후보 매체 전체의 폐기를 실행하고 유효한 원 성공본을 유지한다. 만료된 원본은 이 실패로 연장하지 않고 보존본만 옮기는 폐기 작업을 우선한다. 원 매체 폐기 뒤 crash라면 후보와 실제 매체 상태를 대조해 pending inventory를 종결하기 전 복원 공개를 막는다. 어느 단계든 폐기가 불가능하거나 결과가 불명이면 D4로 격리하고 완료를 추정하지 않는다.

복원용 scratch DB·복호화 임시물도 다른 성공본과 **독립적으로 전체 폐기 가능한 매체**를 job별로 등록해 사용한다. 실패 또는 검증 종료 때 승격되지 않은 scratch 매체 전부를 즉시 폐기하며, 일부 파일 삭제 성공으로 끝내지 않는다. 검증된 DB의 primary 승격은 별도 inventory 전환으로 기록한다. 필요한 scratch 매체를 확보하지 못했으면 공유 backup 매체에 임시로 쓰지 않고 해당 작업을 시작하지 않는다.

### Control 매체의 compaction

물리 compaction의 구현 후보는 B writer를 정지·fence한 뒤 **살아야 할 journal과 inventory만 새 암호화 control 매체/cluster로 재작성**하고, C의 compaction reservation과 새 상태를 대조해 승격하는 것이다. 옛 B 매체는 재작성 임시물·옛 WAL을 포함해 전체 폐기한다. 현 매체와 재작성 매체를 독립적으로 지울 수 있는 spare media 및 제조사가 지원하는 검증 가능한 sanitize, 또는 모든 복구키 사본을 포함한 검증된 암호키 파괴가 필요하다. 이 계획된 전환도 임의 B restore가 아니며 양쪽 writer 장벽과 C head 연속성을 확인해야 한다. B의 계속 늘어나는 WAL이나 원본 cluster backup을 남겨 UUID를 보존하는 방법은 쓰지 않는다.

WAL의 crash 복구와 disk 재사용만으로 물리 삭제를 보장하지 않는다. 이 방식은 추가 매체와 정리 중 중단 비용이 있고, 더 작은 저장소/암호키 단위의 폐기를 쓰려면 별도 검증이 필요하다. 보관 기한에 맞는 재작성·매체/키 폐기가 검증되지 않은 storage는 운영 gate가 남는다. 삭제 성공의 증거를 잃으면 조사용 임의 hold를 추가하지 않고 [승인된 D4 장애 예외](../rules/auth-withdrawal-proposal.md#보관과-삭제)의 최소 격리·24시간 대응·복구 후 우선 삭제를 따른다.

## 승인·환경 선택과 후속 결과

사용자 선택은 추천/대안 배치와 실제 장비·독립 관리 책임, B/C의 PostgreSQL 역할·저장 함수/protocol, 파일 암호화 도구 또는 volume 한정 대안, clock 소스·판정값·일일 시각, 지원 매체의 폐기 방법이다. Journal 또는 witness 완전 손실 뒤 기존 auth를 다시 공개할 수 있다는 RPO/RTO는 제안하지 않는다. 다른 손실 수용 정책을 이번 작업에서 정하지 않는다.

아래는 독립 완료할 수 있는 결과와 선행 관계이며 새 Issue나 담당 배정이 아니다.

| 결과 | 완료가 관측되는 상황과 선행 관계 |
| --- | --- |
| 운영 선택 기록·환경 목록 | 사용자 구성 승인, 장비/역할/domain/TLS/clock/폐기 근거가 연결됨. 이 설계안 완료와 별개. |
| 배포·Migration·secret 입력 연결 | 선택된 운영안과 #125의 최종 승인 입력에 따라 단일 API의 시작/종료·명시 Migration이 검증됨. 운영 witness gate의 구현은 별도 결과. |
| Journal/witness·inventory·fencing | 승인된 저장 protocol에 crash와 이전 writer 시험을 통과하고 inventory completeness와 compaction 증거를 얻음. 운영 선택이 선행. |
| 탈퇴 lifecycle·보관 연결 | 기존 승인 schema/lifecycle·재인증/revoke와 위 저장 결과를 통합해 D1–D5 경합/정리를 검증함. 다른 진행 작업의 AC를 소급 확대하지 않음. |
| 복원 조정·실제 실행 증거 | 앞 결과와 복구용 환경을 확보한 뒤 [검증 matrix](auth-operations-validation-proposal.md#후속-실행-matrix)를 실제 수행하고 중지/재개를 확인함. Credential/provider/DB/backup 실행의 별도 허용이 필요. |

## 공식 근거와 한계

다음은 **2026-09-07 공식 문서 확인**이며 LDB 장비/구현 검증 결과가 아니다. 역할·protocol·배치 선택은 이 근거를 적용한 제안이다.

- PostgreSQL [WAL durability](https://www.postgresql.org/docs/18/wal-reliability.html)와 [WAL 설정](https://www.postgresql.org/docs/18/runtime-config-wal.html): flush를 존중하는 실제 storage가 전제이고 `synchronous_commit`/`fsync` 의미를 구분한다.
- PostgreSQL [row lock](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS)·[CONNECT 권한](https://www.postgresql.org/docs/18/ddl-priv.html#PRIVILEGE-CONNECT)·[SECURITY DEFINER](https://www.postgresql.org/docs/18/sql-createfunction.html): transaction lock과 함수 권한을 조합해야 하며 접속 시작 때의 CONNECT 검사만으로 기존 writer를 차단할 수 없다.
- PostgreSQL [PITR](https://www.postgresql.org/docs/18/continuous-archiving.html): cluster의 과거 정합 상태 복원이 가능하므로 같은 복원 범위의 head를 독립 최신값으로 간주하지 않는다. [RFC 9162의 consistency 검증](https://www.rfc-editor.org/rfc/rfc9162.html#section-8.3)은 과거 known-good head와 대조하는 근거이며 CT service/library 도입 제안은 아니다.
- PostgreSQL [`pg_dump`](https://www.postgresql.org/docs/18/app-pgdump.html): 단일 DB의 일관된 export이며 role 등 cluster 전역 객체와 별개다. 일반적인 대규모 운영 backup의 기본 선택으로 확대하지 않는다. [age 공식 프로젝트](https://github.com/FiloSottile/age)는 stream 입력과 recipient 암호화 CLI를 제공하며 보관/폐기 정책을 대신하지 않는다.
