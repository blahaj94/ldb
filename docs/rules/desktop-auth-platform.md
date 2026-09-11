---
type: rule
status: active
enforcement: approval-required
scope: apps/desktop secure storage protocol and validation
last-reviewed: 2026-09-12
rationale: 지원 환경의 관측 사실과 OS 보장·배포 gate를 구분하고 불명확한 token의 재사용을 차단한다.
evidence: "PR #60 사용자 승인: https://github.com/blahaj94/ldb/pull/60#issuecomment-5553807475 ; 설계 근거: Issue #55; main a82547c; Electron 39.8.10 공식 문서"
exceptions: 실제 credential/keychain·protocol registry·OAuth app 설정과 packaged E2E는 수행하지 않는다.
review-after: 출시 OS 및 package 선택, Electron 변경, 최초 저장·protocol E2E 시
---

# Desktop Authentication Platform

승인 상태·IPC/화면은 [Desktop contract](desktop-auth.md), 상태 전이는 [lifecycle](desktop-auth-lifecycle.md)을 따른다. 이 문서는 OS 동작을 이미 구현·검증했다는 주장이 아니다.

## 확인한 사실과 근거의 한계

2026-09-06 조사 범위는 repository source/config와 공식 문서, host의 OS version·architecture 읽기다. Electron 실행, DB/OAuth/provider 호출, Keychain/DPAPI/secret store 접근, protocol 등록/변경은 수행하지 않았다.

| 분류 | 확인 내용 | 아직 증명하지 않은 것 |
| --- | --- | --- |
| Source/config | `apps/desktop/package.json` 범위는 Electron `^39.2.6`, `pnpm-lock.yaml` 해결 version은 **39.8.10**, electron-builder **26.15.3** | 설치 runtime 실행·지원 최신성·배포 안전성 |
| Packaging 선언 | `apps/desktop/electron-builder.yml`: Windows/NSIS, macOS/DMG, Linux AppImage/snap/deb 관련 설정 | LDB의 실제 지원 OS/arch 약속, package 생성/설치·인증 성공 |
| Placeholder/미구현 | appId `com.electron.app`, productName `apps-desktop`, Windows model ID `com.electron`, `notarize:false`; protocol 선언·handler·single-instance·safeStorage 없음 | 실제 배포 identity·서명·공증·scheme/host/path가 확정됐다는 근거가 아님 |
| Host 관측 | macOS **26.6.2 / arm64**, `sw_vers -productVersion`, `uname -m` 읽기 | macOS 앱/Keychain 성공, Windows/Linux 실행 성공 |
| Electron 공식 범위 | Pinned README는 macOS 12+ Intel/Apple Silicon, Windows 10+ x86/x64/arm64, Linux Ubuntu 18.04+/Fedora 32+/Debian 10+ 검증 목록을 명시 | Electron 지원 설명은 LDB 최소 OS나 해당 OS의 현재 보안 지원 기간을 확정하지 않음 |

근거: [Electron 39.8.10 README](https://raw.githubusercontent.com/electron/electron/v39.8.10/README.md), [safeStorage](https://raw.githubusercontent.com/electron/electron/v39.8.10/docs/api/safe-storage.md), [app lifecycle/path](https://raw.githubusercontent.com/electron/electron/v39.8.10/docs/api/app.md), [pinned Deep Links guide](https://raw.githubusercontent.com/electron/electron/v39.8.10/docs/tutorial/launch-app-from-url-in-another-app.md). 문서 확인을 실제 LDB E2E 결과로 표시하지 않는다. 출시 전 Electron/OS 지원 상태도 다시 확인하며 version 교체는 별도 변경 범위다.

## Clock과 절전 관측

시간 신뢰 판정과 수치 예산은 [lifecycle의 로컬 clock 신뢰](desktop-auth-lifecycle.md#로컬-clock-신뢰)를 따릅니다. 제품 main은 ready와 단일 인스턴스 ownership 확인 뒤 인증 dependency 생성 전에 `powerMonitor`의 `suspend`와 `resume`을 연결합니다. 취소 가능한 quit 동안 listener를 유지하고, 확정 종료·fatal 초기화 실패 또는 auth runtime을 만들지 않는 fallback에서 해제합니다. Listener는 clock 구간을 무효화하며 credential을 삭제하거나 자동 refresh하지 않습니다.

Node `performance.now()`는 process 기준의 monotonic 값이고 서버 시간이 아닙니다. Wall clock 조정과 두 clock의 drift는 별개로 다뤄야 합니다. Electron의 이벤트 API도 실제 package에서 이벤트가 제때 도착하거나 모든 절전을 포착했다는 증거는 아닙니다. 두 시계가 같은 만큼 이동하고 OS 이벤트도 관측하지 못한 경우를 상대 차이 검사만으로 절전이라고 판별할 수 없습니다. 실제 OS clock을 변경하는 검증은 이번 주입 테스트 범위에 포함하지 않습니다.

출시 OS·architecture·package마다 절전 진입/복귀, 긴 main thread 중단, 시계 조정, 장기 drift와 이벤트 전달 순서를 별도로 검증합니다. 주입된 읽기 함수와 EventEmitter의 테스트 성공은 이 native gate를 해소하지 않습니다. 1,000 ms 정책 예산의 가용성 비용도 실제 환경에서 확인하고, 변경이 필요하면 같은 Rule 변경 절차를 따릅니다.

## OS 저장 선택

**권장: main 전용 Electron `safeStorage` 암복호화 + app 전용 암호문 file.** 기존 Electron 기능이라 새 native dependency가 필요 없고 선언된 세 OS 계열을 다룰 수 있다. safeStorage 자체는 credential file 저장·atomic replacement·삭제를 제공하지 않는다. 아래 file protocol을 함께 구현해야 한다.

| OS | 공식 보호 경계 | 인증 허용 조건·미확인 |
| --- | --- | --- |
| macOS | Keychain에 app encryption key 보관 | ready 뒤 encryption availability·실제 암복호화 성공 확인. Keychain lock/거절, 서명 identity·업데이트·다른 bundle 복원 검증 필요 |
| Windows | DPAPI 기반. 다른 OS user에 대한 보호이며 같은 user의 다른 app 차단을 보장하지 않음 | availability·암복호화 실패 처리, user/profile 이동·업데이트 검증 필요. OS credential vault의 app 격리로 표현하지 않음 |
| Linux | Backend는 환경에 따라 libsecret/KWallet 등 | availability=true이며 `gnome_libsecret`, `kwallet`, `kwallet5`, `kwallet6` 중 하나만 허용. `basic_text`, `unknown`, 예상 밖 backend는 storageBlocked |

`setUsePlainTextEncryption(true)` 및 평문/renderer storage/access-only fallback은 금지한다. 안전한 backend가 없으면 로그인과 로그인 유지가 불가능하다는 명시적 선택이다. Capture·브라우저 권한 변경으로 저장 문제를 우회하지 않는다.

Pinned safeStorage는 동기 API이며 OS prompt가 main thread를 막을 수 있다. OS 사용자 승인/취소가 필요할 수 있고 JavaScript timer로 prompt를 취소하거나 일정 시간 내 UI 응답을 보장하지 않는다. Credential 접근 전 안내를 표시하고 완료/거절 뒤 상태를 반영한다. JS HTTP deadline은 이 OS prompt의 강제 종료 예산이 아니다.

| 대안 | 비교·판단 |
| --- | --- |
| OS별 credential manager/native library | App-specific UX를 제공할 수 있지만 새 dependency·ABI/packaging·세 OS 구현을 추가한다. 현재 요구를 넘는 app 격리나 OS UX가 필요하면 별도 승인안으로 재검토 |
| Memory-only refresh | Disk 장애 경계는 줄지만 앱 재시작 로그인 유지 요구를 충족하지 못한다. 자동 fallback으로 채택하지 않음 |
| 평문 file/localStorage | OS 보호와 main 소유 경계를 충족하지 못하므로 채택하지 않음 |

## Credential file과 crash 복구

Path는 main이 고정한 `app.getPath('userData')/auth/<environment>/` 아래로 한정한다. `<environment>`는 trusted build 설정의 제한된 값이며 renderer 입력이 아니다. Dev/test/prod는 userData·API origin·protocol identity를 분리한다. 실제 directory/backup·OS ACL 동작은 platform 검증 대상이다.

- `credential.v1`: version, environment/API origin/clientId context, safeStorage ciphertext만 담는 최대 16,384-byte record. 암호화 payload는 동일 context와 canonical refresh token 하나다. Access/user/nickname/pending/verifier/code/launch URL은 저장하지 않는다. Context mismatch/unknown version/key/형식/크기 오류는 복원하지 않는다.
- `transition.v1`: secret 없는 durable marker. Version, local operation ID, 종류(`exchange`, `refresh`, `clear`)만 가진다. Marker가 있으면 credential file의 값은 **어느 version이든 사용 불가**다. Local operation ID는 서버 credential/ID와 별개다.
- File IO는 main 전용이며 directory ownership과 regular file 여부를 확인한다. Symlink/예상 밖 type·권한 오류는 fail closed다. POSIX directory/file 권한은 0700/0600, Windows는 해당 user의 private profile ACL을 검증한다. Temporary file은 동일 directory에서 exclusive 생성하고 같은 제한을 적용한다. Backup/이전 token 사본을 recovery source로 남기지 않는다.

### POSIX profile ancestor permissions (proposed)

```yaml
status: proposed
enforcement: approval-required
rationale: 최종 profile이 private이어도 교체 가능한 상위 directory를 통해 profile과 credential 경로가 훼손되는 경계를 보수적으로 제한한다.
evidence: Issue #425, PR #422 review discussion_r3992882587
exceptions: sticky bit를 이용한 group/other write 예외를 두지 않으며, POSIX mode bits로 확장 ACL이나 Windows ACL을 보장하지 않는다.
review-after: Issue #425 구현 PR의 사용자 merge와 POSIX·native profile 검증 후
```

Issue #425의 같은 PR에서 이 채택안을 구현과 함께 검토한다. POSIX UID를 조회할 수 있는 경우, existing profile ancestor와 final direct parent는 root UID `0` 또는 현재 process UID가 소유하고 `mode & 0o022 === 0`이어야 한다. Final profile directory의 기존 current-UID `0700` 검사와 missing component의 `0700` 생성은 유지한다. 이 조건을 확인하기 전에는 `mkdir`, Electron `setPath`, app name, app identity setter를 시작하지 않는다. POSIX UID를 조회할 수 없는 환경과 Windows는 mode bits로 owner/ACL 안전성을 추정하지 않으며 native ACL·reparse-point 검증을 별도 gate로 남긴다.

네트워크 transaction과 disk write를 원자적으로 묶을 수 없으므로 **결과 불명 token은 사용하지 않는 marker 방식**을 선택한다. 순서는 다음과 같다.

1. 필요하면 기존 ready refresh를 main memory에 읽는다. Single writer 안에서 marker를 durable 생성/교체하고 성공을 확인한다. 실패하면 exchange/refresh를 보내지 않으며 storageBlocked다. 이미 남은 marker를 무시하고 덮어쓴 token으로 재시도하지 않는다.
2. Exchange/refresh를 1회 전송한다. Refresh R0가 기존 file에 있더라도 marker가 있으므로 crash 후 R0를 다시 보내지 않는다. 네트워크 전 crash도 보수적으로 새 로그인을 요구할 수 있다.
3. 성공 응답을 완전히 검증하고 safeStorage로 R1을 암호화한다. 동일 directory 임시 file write→file flush→atomic replace→해당 platform의 directory durability 확인 순서로 새 credential record를 commit한다. Write/replace 결과 불명은 성공이 아니다.
4. Credential commit과 generation 유효성을 확인한 뒤 marker 삭제와 그 durability까지 확인한다. **이 단계 뒤에만** signedIn 또는 shared refresh 성공을 publish한다. Logout/cancel이 끼어들면 publish하지 않고 clear로 직렬화한다. Marker unlink 뒤 directory flush 실패처럼 삭제 결과가 불명이면 marker가 남았다고 가정하지 않는다. 먼저 marker를 다시 durable 확립해 재복원 금지를 확인한다.
5. 실패/취소는 marker 유지·필요한 재확립을 확인하고 알려진 credential의 서버 logout을 lifecycle 규격대로 최대 1회 시도한다. **재확립도 실패하면** 현재 process는 token을 쓰지 않되 `storageBlocked/LOCAL_CLEAR_UNCONFIRMED`로 전환한다. 이 경우 새 R1 record만 남아 재시작 시 정상 복원될 가능성이 있어 “다음 실행도 로그인되지 않음”을 보장하지 않는다. 서버 204를 확인했어도 local 삭제 완료와 구분하며, 후자가 미확인이면 전체 logout 완료로 표시하지 않는다.
6. Local clear는 marker 확립→credential 및 이 작업 소유 temp file 제거→삭제 durability 확인→marker 제거/durability 순서다. Clean 상태 확인 후 signedOut 또는 새 login을 허용한다. 이 삭제 과정에서도 marker 상태가 불명하면 위 재확립·실패 안내 규칙을 적용한다.

App 시작 시 marker가 있으면 새/옛 credential을 **복호화해서 자동 refresh하지 않는다**. 파일과 owned temporary record를 위 clear 순서로 제거하고 성공하면 signedOut/REAUTH_REQUIRED, 실패하면 storageBlocked다. Marker 없이 정상 credential 하나만 있으면 복원한다. 손상 record는 사용하지 않고 같은 clear/실패 규칙을 따른다. Backend 잠금·일시적 복호화 거절은 credential을 임의 평문 복원하지 않고 storageBlocked로 유지한다. retryAuth에서 접근이 회복되고 record/marker가 정상일 때만 정상 복원을 재개한다.

`LOGIN_EXCHANGE_INVALID`처럼 명시적인 비성공 응답 뒤 pending을 계속 기다릴 때는 secret 없는 marker를 안전하게 clear한 다음 waitingBrowser로 돌아간다. Clear 실패는 storageBlocked다. Pending memory를 file로 이동하거나 같은 code를 자동 재전송하지 않는다.

| Crash/failure 지점 | 다음 실행의 선택 |
| --- | --- |
| Marker 확립 전 | 새 exchange/refresh 전송 없음. 기존 ready R0는 여전히 current일 수 있으며 정상 복원 대상 |
| Marker 확립 후, 전송 전/후/응답 유실 | File의 R0를 무시하고 local clear 후 새 로그인. 서버 폐기 완료를 추정하지 않음 |
| R1 임시 write/replace/flush 중 | Marker가 남아 있으므로 R0/R1 둘 다 사용하지 않음. Temp나 이전 file을 복구 후보로 탐색하지 않음 |
| R1 durable commit 후 marker 제거 전 | 보수적으로 R1도 버리고 새 로그인. 일부 정상 session을 포기하는 가용성 비용을 수용 |
| Marker unlink 뒤 durability 실패, 재확립 결과 | Durable 재확립 성공이면 R1도 복원 0. 재확립 실패면 R1만 남을 수 있어 다음 실행의 자동 복원 차단은 미확인; LOCAL_CLEAR_UNCONFIRMED 안내. R0는 앞서 R1 durable commit으로 교체됐어야 함 |
| Marker 제거 durability 확인 후 | R1만 정상 복원 대상. R0 사본은 없음 |
| Logout에서 marker 확립/credential 삭제조차 실패 | 현재 process는 사용을 중단하지만 재시작 시 이전 record가 남을 가능성을 배제하지 못함. storageBlocked/LOCAL_CLEAR_UNCONFIRMED로 안내하며 영구 logout 성공을 표시하지 않음 |

Atomic replacement·flush·directory durability는 Node 호출 하나의 반환만으로 모든 filesystem/power-loss에서 보장하지 않는다. 위 순서를 만족하는 OS별 구현과 fault injection이 release gate다. 지원 filesystem에서 durability를 확인할 수 없으면 조용히 flush를 생략하거나 이전 token fallback을 넣지 않고 해당 배포의 로그인 유지를 보류한다. Disk rollback/OS profile backup 복원·동일 OS user malware까지 이 marker가 방어하지 않는다. 서버 reuse 탐지와 OS별 한계를 함께 유지한다. 암호문은 userData에 존재하므로 “credential이 OS 저장소 밖에 없다”거나 secure physical erase를 보장하지 않는다.

## Protocol 및 browser launch 선택

**권장: 서버의 HTTPS provider callback → 완료 HTML의 등록 private protocol 버튼 → main.** 이미 승인된 return target snapshot/code-only 흐름을 그대로 소비하며 새 listener 없이 앱을 활성화한다. 정확한 scheme/host/path는 owned namespace와 배포 identity를 확인한 후 server registry와 packaged 앱에 동일하게 등록한다. 현재 placeholder나 임의 `ldb://...`를 실제 등록값으로 간주하지 않는다.

Private protocol은 같은 OS user의 다른 앱이 가로챌 수 있다. Pending request + S256 verifier가 없는 앱은 자체 code를 교환할 수 없지만 가용성 방해·정품 앱 보증 문제를 모두 해결하지 않는다. Public clientId도 설치 인증이 아니다. [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html)는 private-use scheme/claimed HTTPS/loopback을 비교하며 Linux 직접 OAuth callback에 loopback을 권고한다. 이번 선택은 중앙 HTTPS callback 이후 별도 code 복귀라는 프로젝트 trade-off이며 모든 OS의 최선이라는 주장이 아니다.

Claimed HTTPS는 domain association·OS별 배포 검증을 추가하고, loopback은 listener/port/lifecycle과 현재 return registry 형태에 대한 별도 결정을 요구한다. 실제 private protocol을 안정적으로 등록할 수 없는 배포를 선택한다면 해당 대안과 서버 registry 영향부터 별도 승인받는다. 임의 loopback redirect나 manual token/code 붙여넣기를 fallback으로 추가하지 않는다.

| 진입점 | 등록·처리 계약 | 미확인 gate |
| --- | --- | --- |
| macOS | main entry에서 ready 이전 `open-url` listener 등록 및 preventDefault. Bundle `CFBundleURLTypes`에 승인 target의 scheme 선언. OS event를 단일 validator로 전달 | Packaged/installed cold·warm·창 없음, 서명/업데이트, 여러 bundle의 association 충돌 |
| Windows/Linux | Packaged executable 또는 Electron `defaultApp`의 executable·app path를 제거한 user argv를 검사한다. Lock loser가 bounded/versioned `additionalData`로 같은 user argv를 보내며 owner는 이를 재검증하고 mutable `second-instance` command line을 인증 판정에 쓰지 않는다. Single-instance loser는 store/network 작업 없이 종료 | Install 경로 공백, URI 전달·중복, 실제 default handler와 OS별 focus |
| 공통 | Bootstrap에서 event handler와 single-instance ownership을 준비한 뒤 ready·store·window를 초기화. 초기 후보는 raw 2,048 byte 이하 1개만 일시 보유하고 추가 후보는 버림 | Cold start는 pending verifier가 없어 교환하지 않음. 정상 저장 session 복원과 독립적으로 안내 |

Single-instance의 범위는 동일 app profile이며 서로 다른 dev/prod app은 별도 identity를 쓴다. macOS에서 창만 닫아 main이 살아 있으면 pending은 유지하고 유효 복귀 때 창을 다시 만든다. Windows/Linux의 마지막 창 닫힘은 현재 lifecycle상 main quit이므로 pending은 소실된다. Packaged 앱은 URL을 처리하기 위해 창에 URL을 load하지 않고 local renderer만 생성·restore·focus한다. Foreground 전환은 OS가 제한할 수 있어 상태 완료와 focus 성공을 구분한다.

### 입력 검증

- Browser launch URL은 string·2,048 byte 이하이며 exact trusted API HTTPS origin, `/auth/login/authorize` path, **ticket 하나**의 canonical 32-byte base64url query만 허용한다. Username/password·fragment·추가 query·path/port alias·redirect를 허용하지 않는다. URL parser 뒤 canonical 재구성한 값과 원문이 동일해야 하며 allowlist prefix 비교로 대체하지 않는다.
- App 복귀 후보는 bootstrap argument를 제거한 초기 user argv 또는 exact version·shape·count·UTF-8 byte 경계를 다시 확인한 lock handoff의 모든 문자열에서 검사한다. `second-instance` command line의 순서·내용을 인증 입력으로 신뢰하거나 마지막 argument라고 가정하거나 joined command line을 shell로 재해석하거나 arbitrary command를 실행하지 않는다. 한 OS event에 복귀 후보가 2개 이상이면 전체 거절한다. 제거된 executable/app path와 단독 `--` 등 일반 argument를 URL로 취급하지 않는다. `--` 또는 slash prefix option의 첫 `=`나 `:` 뒤 payload는 option 이름의 punctuation·빈 이름과 무관하게 URL-like 분류 대상으로 검사한다. Slash prefix 이름에 path separator가 있으면 POSIX path로 유지한다. 예외는 대소문자를 정규화한 option 이름이 정확히 `user-data-dir`이고 raw argument·payload에 trim/control projection이 없으며, payload가 drive letter와 colon 뒤에 slash 또는 backslash가 정확히 하나인 absolute Windows drive 형태(`C:/...`, `C:\...`)일 때뿐이다. Well-formed scheme 또는 path/query/fragment 구분자 없는 prefix 뒤의 colon과 slash/backslash로 시작하는 형태는 protocol-like이다. Direct drive-shaped user argument와 다른 option의 drive-shaped payload, control 제거 뒤에만 drive path가 되는 값처럼 one-letter URI와 구별할 수 없는 입력은 fail closed한다.
- 복귀 URL도 2,048 byte 이하·control/공백/backslash 없음·정확한 등록 scheme/host/path여야 한다. Userinfo/port/fragment·추가 path·encoded 구분자·dot segment·unknown/duplicate query key를 거절한다. Canonical raw 값은 `<registered-return-target>?code=<canonical-code>`와 정확히 같아야 한다. 대상 target의 authority 유무까지 등록 형태를 따른다.
- Code는 auth-oauth의 **43자 canonical unpadded base64url, decode 32byte, re-encode 동일**만 허용한다. Code를 URL decode 반복/coercion/trim으로 보정하지 않는다. 입력 code만으로 request/provider/user를 선택하지 않는다.
- URL을 network로 따라가거나 renderer로 전달하지 않는다. Validation 실패·잘못된 scheme은 기존 pending/session·window navigation에 side effect가 없다. 정상 URL도 현재 pending이 없으면 교환 0이다. 동일 code의 중복·expired handling은 lifecycle을 따른다.

### Linux package별 gate

- deb: 설치된 `.desktop`, `MimeType=x-scheme-handler/...`, `Exec`의 URI 전달, default association·업데이트·제거를 검증한다. [electron-builder v26 Linux](https://www.electron.build/v26/docs/linux/)
- AppImage: electron-builder 21 이후 self desktop integration이 없으므로 AppImage 실행 성공은 browser 복귀 보장이 아니다. Desktop integration 배포 방법을 먼저 선택한다. [AppImage 안내](https://www.electron.build/v26/docs/appimage/#desktop-integration)
- snap: installed desktop entry·URI 전달, confinement·secret store 접근을 따로 확인한다. `password-manager-service` 자동 연결을 가정하지 않으며 추가 interface 채택은 배포 결정이다. [desktop interface](https://snapcraft.io/docs/reference/interfaces/desktop-interface/), [password-manager-service](https://snapcraft.io/docs/reference/interfaces/password-manager-service-interface/)

## 향후 검증 계획과 완료 판정

이번에 실행한 것은 source/config·승인 evidence·공식 문서 대조와 PR에 기록한 문서 검사뿐이다. 아래는 **미실행 validation matrix**다. 후속 구현 Issue는 [testing](testing.md)의 Red→Green과 `apps/desktop/AGENTS.md`를 따른다. Unit mock 통과와 실제 OS/provider 성공을 분리한다.

| 층 | 검증 사례 | 통과 기준 |
| --- | --- | --- |
| Main unit | 신규/중복 begin, enabled provider, exact argument/sender/frame/URL | 잘못된 입력은 HTTP/store/browser side effect 0; subframe/다른 창 거절 |
| Preload/component | event wrapper/unsubscribe, subscribe→snapshot race, reload·늦은 revision | raw Electron event/credential 미노출, listener 누수·stale snapshot overwrite 없음 |
| PKCE/parser | 매번 독립 verifier, S256 ASCII hash, code canonical·중복 query·alias·oversize argv | 승인된 정확한 값만 exchange; unknown target은 fetch/openExternal 0 |
| Lifecycle unit | 600초 경계·절전/clock 변화, provider/browser 취소, 앱 취소·late response | TTL 연장/서버 취소 추정 없음; cancelled generation signedIn 0 |
| Exchange integration | 정상 신규/기존, wrong proof/다른 request code, 중복 버튼·60초 만료·응답 유실 | 최종 서버 session 1개 이하, 저장 전 signedIn 0, code 자동 retry 0 |
| Refresh unit/integration | 여러 caller·오래된 access 401·15초 abort·401/503/불완전 body | session당 refresh 1회·공유 결과; 결과 불명 R0 재사용 0·mutation 자동 replay 0 |
| Store fault injection | marker/write/flush/replace/delete의 각 단계 실패와 crash; unlink 뒤 flush 실패·marker 재확립 성공/실패 포함 | marker 있으면 R0/R1 자동 복원 0. 재확립 미확인은 자동 복원 차단을 보장하지 않고 정확히 안내; clean/ready 판정 정확 |
| Logout 경합 | refresh/exchange 중 logout·두 logout·새 로그인·늦은 200·offline | generation 복구 0; known current/consumed session만 폐기; 서버 204 미확인 성공 표시 0 |
| Restore/activity | restart 성공·offline·refresh 성공 후 `/me` 실패·marker/손상 | pending 복원 0, 정상 refresh 뒤 `/me`·home; background 활동 heartbeat 0 |
| UI/capture 회귀 | welcome/home, logout/401/unmount, 늦은 OCR, sandbox/preload bundle | 기존 source/media validation 유지, stream/worker/loop cleanup, 재로그인 자동 capture 0 |
| Native storage | Keychain 잠금/거절·서명 업데이트, DPAPI user/profile 변경, 각 허용 Linux backend | 보호 가능성·decrypt 결과를 실제 확인; basic_text/unknown에서는 로그인 0 |
| Native protocol | 출시할 OS/arch/package 각각 installed cold/warm/창 없음·다중 instance·잘못된 URL | 초기 event 유실/중복 교환 0, local renderer 복귀, 등록값과 server snapshot 일치 |
| Provider/실배포 | 실제 HTTPS/domain/provider 등록, browser별 동의·취소, Discord 별도 PKCE gate | 실제 credential E2E를 별도 evidence로 기록. Mock 또는 Google 성공으로 Discord 성공 대체 금지 |
| Log sink | synthetic credential canary로 main/preload/renderer/HTTP/deep-link/error·crash 경로 | 원문 credential/URL/body/user/nickname 노출 0. 실제 secret을 test evidence에 사용하지 않음 |

제품 구현의 기본 command는 `pnpm --filter @ldb/desktop run --sequential '/^(test|lint|build)$/'`다. Build에 typecheck가 포함된다. 연결한 서버 범위는 API validation을 함께 수행하고 실제 packaged matrix는 선택 OS/arch별 별도 evidence로 남긴다. 문서-only PR에서는 app command·설치·credential E2E를 실행하지 않는다.

## 남은 선택과 release gate

| 구분 | 필요한 결정·evidence | 현재 처리 |
| --- | --- | --- |
| Rule 승인 | 3개 문서의 main/IPC/UI·lifecycle·저장/protocol contract에 대한 [PR #60 사용자 승인](https://github.com/blahaj94/ldb/pull/60#issuecomment-5553807475) | 승인됨, PR #60 사용자 merge 완료. 제품 구현·실제 OS 검증과 별개 |
| 사용자 배포 선택 | 최초 출시 OS·minimum version·architecture와 Linux 포함 시 package 종류 | 세 OS build 설정은 관측했지만 실제 지원 약속은 미결정. Windows 우선 등을 게임 맥락만으로 추정하지 않음 |
| 실제 등록값 | API HTTPS origin, provider HTTPS callbacks/config version, owned scheme/target, app/bundle identity·서명/공증, dev/prod 분리 | Placeholder 채택 금지. Server registry와 OS package의 동일 tuple 확인 필요 |
| OS 실행 evidence | secret backend/권한/prompt·durability·protocol association·업데이트/복구 | 모든 native 인증 동작 미검증. 실패 platform을 성공 matrix에 포함하지 않음 |
| 서버 선행 | login request/exchange/provider/refresh/logout/`GET /me` 구현·연동, Discord PKCE gate | PR #53은 DB 기반 완료이며 endpoint 전체 구현 완료로 해석하지 않음. #54와 후속 task의 결과 필요 |

설계 승인과 실제 등록값 결정은 구분한다. 등록값이 없어도 mock 기반 후속 task를 구체화할 수 있지만 실제 browser/packaged release gate는 해소되지 않는다. 후속 task 배정과 부모 전체 상태 관리는 총괄에게 맡기며 향후 PR도 사용자가 squash merge한다.
