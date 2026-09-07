---
type: rule
status: proposed
enforcement: approval-required
scope: authentication operations recovery verification and failure response
last-reviewed: 2026-09-07
rationale: 삭제 보존 복원의 재개 조건과 실패 시 중단 증거를 실제 시험 가능한 형태로 연결한다.
evidence: "Issue #130: https://github.com/blahaj94/ldb/issues/130 ; D1–D5 승인: https://github.com/blahaj94/ldb/pull/72#issuecomment-5557976162"
exceptions: 문서 검토용 계획이며 아래 runtime·DB·backup·key·provider 실행을 수행했거나 허가받았다는 뜻이 아니다.
review-after: 구성 승인 또는 최초 장애/복원 시험과 저장소 변경 시
---

# 인증 운영 복원·검증 제안

[운영 구성 제안](auth-operations-proposal.md)의 복구 담당은 각 단계의 증거를 확인한 뒤 다음 단계로 간다. 하나라도 불명확하면 유지보수 상태를 유지한다. 아래 순서는 [승인된 복원 순서](../rules/auth-withdrawal-proposal.md#삭제를-보존하는-복원-기준과-순서)를 운영 역할과 관측 결과에 연결하며 D1–D5를 새로 정하지 않는다.

## 복원 순서와 재개 조건

| 순서 | 실행 책임과 기대 결과 | 다음 단계에 필요한 증거 |
| --- | --- | --- |
| 1. 서비스 중지 | 복구 담당이 공개·우회 ingress, callback/exchange/refresh/account write, background/cleanup/Migration job을 닫고 이전 API를 중지한다. C→B generation 장벽으로 옛 writer를 차단한 뒤 journal을 최종 대조한다. | 이전 DB transaction/연결 종료, 두 저장소의 새 generation과 역할 binding, pending reservation 종결 또는 중지 이유. Journal 최신성을 증명하지 못하면 restore를 시작하지 않음. |
| 2. 격리 DB 복원 | Inventory의 나이 7일 미만인 승인 사본만 별도 DB/volume에 복원한다. Snapshot origin/lineage·digest와 현 journal/compaction 경계를 확인한다. | 실제 사본 목록과 inventory 일치, C continuity와 B/C head 일치, 신뢰 clock, 격리 network/role. Origin이 없는 사본이나 만료본은 입력 거절. |
| 3. 삭제 재적용 | Journal의 모든 관련 intent oldUserId에 대해 user·개인 데이터 FK를 삭제한다. 미완료 intent도 적용한다. | Old UUID 부재·FK 무결성. 새 재가입 UUID 보존. Preparing만 있고 최종 journal과 C에 확정/불명 intent가 없다는 증거가 있을 때만 미확정 종결. Accepted/deleting인데 journal이 없으면 중지. |
| 4. 전체 자격 폐기 | 복원된 모든 session/refresh/OAuth, withdrawal proof/receipt·identity fence를 제거한다. 미확정 preparation은 폐기하고 확정 obligation은 journal에서만 재개한다. | 각 자격의 활성/잔여 row 0. Receipt 재발급 없음. Provider revoke 재실행 0. |
| 5. 새 key·lineage | Secret 관리 담당이 허용된 운영 절차로 새 ES256 signing key/kid·PKCE key·fence key를 준비하고 전체 verifier에 적용한다. | 모든 옛 verify key 제거, 새 설정 version/lineage 반영. 정상 900초 overlap을 복원에 적용하지 않음. Key 원문은 evidence 제외. |
| 6. 격리 검증 | Old JWT/refresh/code/receipt 거절, 새 UUID 보존과 새 요청 flow를 검증한다. 삭제 재적용·검증을 통과한 DB만 승격 후보로 둔다. | 참조 무결성·old UUID 부재·자격 0·key 일치 결과. Snapshot lineage 승격을 age 리셋으로 사용하지 않음. |
| 7. 600초 유지 후 재개 | 마지막 journal 대조 시점부터 신규 login admission을 600초 닫는다. 그 사이 새 intent가 생기면 quiescence 실패로 다시 대조하고 시간을 다시 센다. 전체 process 반영과 검증 뒤 cutover한다. | 신뢰 clock의 600초 경과, 그 구간 journal 변경 없음, 전체 verifier 새 lineage/key, 옛 process/primary 접근 차단. 실패하면 중지 유지·옛 snapshot 자동 복귀 없음. |

서비스 중지 전에 외부로 나간 revoke의 remote 지연은 D2의 승인된 한계다. 이 복구가 provider grant 상태까지 되돌리거나 확인했다고 표시하지 않는다. 복구 중 상태 확인·재개는 기존 receipt 권한을 새로 만들지 않는다.

## 장애와 운영자 대응

| 관측 | 즉시 유지할 상태 | 운영자 대응과 재개 판단 |
| --- | --- | --- |
| B 또는 C 불가·pending/다른 head | Preparing/확정 obligation 유지, 새 관련 write와 공개 복원 중지. | 연결/권한/저장소를 회복하고 generation 장벽 뒤 exact reservation/intent 대조. C pending·B 부재를 취소 근거로 쓰지 않음. 복구 근거가 없으면 계속 중지. |
| B snapshot rollback·누락 segment | Checksum이 맞아도 현 C와 비교해 중지. | 등록된 현 상태의 payload가 있는지 확인. 더 오래된 backup이나 빈 journal로 대체하지 않음. Loss 자체의 허용 RPO를 새로 정하지 않음. |
| C 초기화·disk 교체·전체 host 복원·관리권 침해 | Witness continuity 상실, 서비스 재개/복원 공개 중지. | 기존 비복원 authority의 연속성을 독립 운영 증거로 확인할 수 없으면 새 witness로 기존 auth를 이어가지 않음. 추천안도 공동 silent rewind 탐지 보장을 주장하지 않음. |
| 이전 writer 접근·장벽 timeout | 옛 writer 완료를 추측하지 않고 gate 유지. | Network/role 차단, 실제 backend/transaction 종료, B/C durable generation·pending 대조. 강제 종료 뒤에도 이미 commit된 intent는 적용. |
| Clock 역행·큰 전진·동기화 불명 | 인증 admission·backup 승격·compaction·공개 복원 중지. | 신뢰 시간과 저장된 origin/deadline을 재대조. TTL/age를 연장하거나 오래된 시각을 새 시각으로 교체하지 않음. |
| Backup 실패·만료본·미등록 copy | 실패본 제거, 만료본 사용 금지, inventory 불명 상태에서 journal compaction/공개 복원 중지. | 모든 목적지/volume/복제본을 대조하고 정확히 소유한 사본을 격리·폐기. 새 성공본이 없어도 오래된 성공본을 연장하지 않음. |
| 일부 DELETE·key 폐기·매체 제거 실패 | 완료 성공을 주장하지 않음. 확정 계정 active 복귀와 unsafe cutover 금지. | 같은 old UUID의 로컬 삭제만 재개. D4 최소 격리, 24시간 초과부터 지연 안내와 매 24시간 재검토. 복구 시 서비스 재개보다 삭제/compaction 우선. |
| 일부 verifier만 새 key | 모든 ingress 중지. | 전 process의 옛 key 제거/새 lineage를 확인한 뒤만 재개. 일부 성공을 전체 PASS로 합산하지 않음. |

운영자는 incident에 정제 code·발생/재검토 시각·영향받은 저장 경계·시도 결과·남은 폐기 경로만 기록한다. User/deletion/request UUID·HMAC·receipt·provider 응답·credential을 일반 log/Issue/PR에 남기지 않는다. 24시간 초과 대응은 승인된 D4 예외이며 임의 조사 보관기간을 추가하지 않는다.

## 후속 실행 matrix

**전체 행은 미실행이다.** 설계 문서의 링크/구조 검증이나 독립 review는 아래 시험의 PASS가 아니다. 실제 실행에는 별도 승인된 구현·격리 환경·운영 허용이 선행한다. Synthetic UUID와 테스트 key를 사용하는 환경에서도 raw secret을 evidence에 저장하지 않는다.

| Case / 입력 | 기대 결과와 관측 evidence | 재개 판단 |
| --- | --- | --- |
| 정상 복원: 삭제 전 backup, 완료 intent, 새 UUID로 재가입 | Old UUID/FK 제거, 새 UUID 보존, session/refresh/OAuth/proof/receipt/fence 0, provider 재호출 0. 단계별 정제 count·무결성 결과. | 전체 key 교체·600초 이후만 가능. |
| Pending intent를 포함한 backup·완료 journal 후처리 유실 | 완료 표식이 없어도 durable intent의 old UUID 삭제. 복구 과정의 완료 확인을 멱등 기록하며 원 completion을 추측해 앞당기지 않음. | Obligation과 B/C head 대조 완료 후 가능. |
| Auth에 preparing만 있고 B/C reservation·intent 모두 없음 | 옛 writer의 양쪽 장벽이 끝난 최종 부재를 확인할 때만 미확정 종결. 복원 user는 active 가능하나 옛 session은 전체 폐기. | 다른 복원 조건까지 충족해야 가능. |
| Accepted/deleting인데 intent 없음 | 불일치로 중지, 탈퇴 완료 오표시·계정 부활 0. | 불가. |
| Origin+7일 직전/정각, 8번째 성공본, 7일간 backup 실패 | 정각부터 restore 거절·폐기 대상. 새 성공본 승격 전 최대 7개. 실패가 보관/age cap을 연장하지 않음. | 유효 사본이 없으면 불가. |
| Copy→restore→re-backup·lineage 변경 | 모든 파생 사본이 origin과 부모를 보존. 새 파일 시각·새 lineage로 age를 세탁하지 않음. | Age 위반 파생본 거절. |
| B journal suffix 삭제·중간 segment 누락·정상 checksum의 옛 snapshot | C head 또는 승인 compaction 경계와 불일치. 현 B checksum 단독 PASS 없음. | 불가. |
| C reservation 전/후, B commit 전/후, C 완료 전/후 process crash | 각 경계에서 crash injection. B durable commit 뒤는 취소 불가. C pending+B 일치 intent는 완료 가능. C pending+B 부재는 미확정 취소 없이 hold. | Exact 대조가 끝난 경우만 가능. |
| B/C commit ack 유실·같은 deletionId 반복·다른 payload | 같은 ID/payload 결과만 멱등 처리. 다른 payload 거절, 중복 sequence/intent·취소/재가입 0. C 불명 상태에서 후속 append 0. | Pending 해소 후만 가능. |
| B commit 후 C 완료 실패·그 사이 B rewind | 예약이 C에 남아 rewind 전의 불확실성을 드러냄. 비동기 witness의 누락 구간이 없음을 관측. | Payload/commit 근거를 회복하지 못하면 불가. |
| C 단독 rollback/교체 또는 B/C 공동 rewind 모의 | 별도 C 관리 continuity 변경을 gate가 거절하는지 확인. 공격자가 관리 증거까지 숨기는 공동 rewind는 이 fault model 밖임을 기록. | C 신뢰를 잃은 사례는 불가. 미탐지를 안전 PASS로 세지 않음. |
| B payload 전체 손실·C 전체 손실·network partition | C digest만으로 UUID 복구 불가, B만으로 C 재생성 불가. 확정 계정 취소/옛 auth 공개 0. | 불가. 실제 데이터 손실의 가용성 한계 공개. |
| Append가 lock을 먼저 획득한 상태에서 generation 전환 | 장벽이 commit/rollback을 기다림. 먼저 commit한 intent는 최종 대조에 포함. | 대기 종료·C pending 종결 후만 가능. |
| Generation 전환이 먼저이고 옛 연결에서 append·현재 숫자 위조 | 저장 함수가 identity+generation으로 거절. 기존 socket·옛 credential·현 숫자를 사용해도 write 0. 직접 DML/DDL/owner 승격 권한 없음. | 옛 writer 차단 증거 충족 시 다음 단계. |
| C reservation과 B append 사이 owner 교체·장벽 timeout | C pending을 유지, B 장벽 뒤 최종 결과 판정. Timeout을 부재/성공으로 취급하지 않음. | 두 저장소 정합 전 불가. |
| Auth의 기존 transaction·cleanup/Migration 연결·late callback | 새 연결 거절과 기존 transaction 종료를 각각 확인. 옛 primary·복원 DB에 늦은 write 0. Provider 재호출 0. | 모든 writer drain 후만 가능. |
| Clock 역행·재부팅·큰 전진·C/A clock 차이·동기화 상실 | Gate 중지, 신뢰 UTC/monotonic evidence. Expiry/age를 연장하지 않고 불명 시 compaction 0. | 선택한 clock 조건 회복 후만 가능. |
| 완료+8일 journal과 폐기 미확인 old backup·UUID segment 잔여 | 시간만으로 compaction하지 않음. Snapshot 제외/폐기와 WAL·임시/복제/매체/key 사본 제거 증거를 함께 요구. | 안전한 삭제·복원 증명 전 불가. |
| Compaction reservation/DB commit/파일 폐기/C 완료 사이 crash | 살아야 할 pending UUID는 유지, 제거 대상 UUID는 최종 보존물에서 제거. 이전 segment 사본을 무기한 rollback용으로 남기지 않음. | 물리 잔여/새 head 검증 전 불가. |
| 실패 dump·취소된 restore·미등록 OS snapshot/replica·키 사본 | 생성 전 등록과 전체 열거 대조. 실패/종료 때 폐기; exact 소유/대상이 불명하면 광역 삭제 대신 격리. | Inventory completeness·폐기 전 불가. |
| 유효 성공본+만료본이 같은 backup 매체/recipient를 공유, 최대 7개 상태에서 새 dump | 보존본만 독립 후보 매체로 복사하고 원 age/lineage·복구 가능성 유지. Source와 임시 candidate의 물리 사본을 모두 등록·age 검사. 원 매체 sanitize 증거→B/C inventory 확정 순서, 최종 성공본 최대 7개이며 새 8번째 승격 전 옛 성공본 폐기 확인. | 유효 성공본 보존·실제 폐기·최신 inventory 확인 후만 가능. |
| Backup 후보의 partial dump·복사/검증 실패, restore scratch 실패/종료 | 후보/scratch 매체 전체를 즉시 폐기하고 유효 source 성공본은 유지. 공유 key 파괴로 유효본을 함께 잃거나 unlink만으로 폐기 성공 표시 0. 실패가 원본 age cap을 연장하지 않음. | 실패 매체 폐기와 유효본 확인 전 작업 완료 아님. 폐기 불가는 D4 격리. |
| Copy 등록 전후·후보 검증·원 매체 sanitize 전후·B/C inventory 완료 사이 crash | 미등록 쓰기 0. 재시작 시 source/candidate/실제 매체를 대조하고 pending 종결 전 공개 복원 0. Sanitize를 시도했다는 기록만으로 원본 폐기 확정 없음; 이미 폐기한 source 자동 복귀 없음. | 유효 후보·실제 폐기·B/C 정합을 모두 증명한 경우만 가능. 후보까지 유실됐으면 불가. |
| DELETE rollback/응답 유실·일부 FK 누락·scratch 폐기 실패 | 같은 old UUID 멱등 재개, 실제 commit 확인 전 완료 없음. FK 누락은 검증 실패. 실패 residue는 D4 격리/24시간 대응. | 안전 evidence가 모두 있어야 가능. |
| 옛 JWT/refresh/code/receipt·일부 key 미전환·600초 중 신규 login | 전원 logout, 옛 credential 거절, admission 0. 새 intent가 있으면 마지막 대조 시각 갱신과 600초 재시작. | 전 verifier 검증과 새 대조 이후만 가능. |
| 정상 key rotation·일반 logout/탈퇴 residual 검색 | 정상 90일 rotation·900초 overlap과 exp까지의 residual 정책 유지. 복원 전용 옛 key 제거 예외를 일반 logout에 확대하지 않음. | 기존 정책과 복원 예외 각각 확인. |
| Receipt/fence/inventory/checkpoint/log TTL·24시간 장애 | D4/D5의 목적별 field/TTL·삭제 시각과 정제 evidence. Clock/매체 장애 때 상한 성공을 보장했다고 표시하지 않음. | 장애 잔여 우선 삭제 후 판단. |

## 기존 정책과의 정합성 확인표

| Canonical 승인 정책 | 이 제안의 적용 |
| --- | --- |
| D1: durable intent 자체가 확정, 응답 유실도 취소 불가 | B commit을 확정점으로 유지한다. 그 전 C reservation, 그 후 C 완료는 최신성 증거 protocol이며 사용자 확정점을 늦추지 않는다. |
| D2: revoke 10초·retry 0, 실패/불명도 로컬 삭제 | 복구 시 재호출하지 않는다. Fencing의 remote 한계를 별도로 표시한다. |
| D3: 완료+600초 이후 생성한 새 요청·새 UUID | Old UUID만 삭제하며 복원 때 전역 600초 admission 중단을 적용한다. |
| D4: receipt 생성+24시간, fence 완료+1,200초, journal 완료 확인+8일 | TTL을 재발급/재시도로 연장하지 않는다. 미완료 intent를 만료시키지 않으며 물리 잔여는 승인된 장애 예외로 관리한다. |
| D5: 최대 7개 AND snapshot age 7일, 모든 copy 포함 | Inventory와 origin lineage를 보존한다. 만료·실패·임시본과 journal compaction 선후를 연결한다. |
| Inventory snapshot+15일, scratch/실패 evidence 종료+8일, log 7일 | 정제 evidence만 보관한다. C 현재/직전 값은 서비스 수명/최대 8일 경계를 유지한다. |
| 정상 key 주기·900초 overlap, 복원 예외 | 정상 정책은 [auth-session.md](../rules/auth-session.md), 복원 시 전체 옛 key 제거는 [탈퇴 Rule](../rules/auth-withdrawal-proposal.md)이 각각 기준이다. |
| 초기 4-table·명시 Migration·기존 cleanup | [auth-database.md](../rules/auth-database.md)·[auth-runtime.md](../rules/auth-runtime.md)를 유지한다. 운영 state와 탈퇴 extension은 별도 구현 결과이며 기존 검증 성공을 소급 변경하지 않는다. |

## 문서 검증과 인계 증거

이번 설계안에는 `git diff --check`, 변경 Markdown의 상대 링크 대상/anchor·fence·구조·diff scope 확인, 위 정합성 대조와 독립 1차·보안/architecture 최종 review가 필요하다. 실행 결과·revision·review finding은 Issue/PR에서 관리하며 이 문서에 완료 로그를 계속 누적하지 않는다.

문서 검증에 app build/test·Docker·Migration·실제 backup/restore 성공을 섞지 않는다. 운영 검증 인계는 선택된 장비/권한·clock·binary revision, fault injection 위치, 기대/실제 결과, gate 상태·폐기 잔여를 구분한다. Source 위치는 file path로만 참조하고 실제 credential·개인식별 값은 포함하지 않는다.
