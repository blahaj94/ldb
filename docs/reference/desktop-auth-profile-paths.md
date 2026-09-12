---
type: reference
status: active
scope: apps/desktop authentication profile path preparation
last-reviewed: 2026-09-12
---

# Desktop Auth Profile Paths

`apps/desktop/src/backend/auth/runtime-config.ts`는 Electron이 인증 runtime을 만들기 전에 trusted `userData` profile path를 준비한다. 입력 path는 native canonical spelling·segment·symlink 규칙을 먼저 통과해야 하며, 이 문서는 기존 leaf 보호와 상위 directory 보호의 현재 구현을 설명한다. 실제 사용자 profile, credential store, OS ACL과 packaged app 실행은 이 reference의 검증 범위가 아니다.

## 검증 순서와 허용 조건

Path component는 root에서 leaf 방향으로 `lstat`한다. 기존 component는 directory이고 symlink가 아니어야 하며 native `realpath` 결과가 입력 spelling과 같아야 한다. 없는 component는 direct parent를 같은 조건으로 확인한 뒤 `0700`으로 만들고, 생성·관측한 directory와 필요한 parent entry를 sync한다. 모든 component와 final parent의 검증·durability 확인이 끝난 뒤에만 Electron `setPath`, name, app identity setter를 호출한다.

| 대상                                    | POSIX 허용 조건                                                             | 변경 동작                               |
| --------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- |
| Final profile directory                 | 현재 UID 소유, permission bits가 정확히 `0700`                              | 기존 권한을 chmod로 보정하지 않음       |
| Existing ancestor와 final direct parent | UID `0` 또는 현재 UID 소유, `group/other write` 없음 (`mode & 0o022 === 0`) | 권한을 보정하지 않음                    |
| Missing component                       | 검증된 parent 아래에서 생성되고 `0700`으로 확인됨                           | 생성 후 directory와 parent entry를 sync |

POSIX UID를 조회할 수 없는 환경에서는 mode bits로 owner·ACL을 추정하지 않는다. Windows에서는 mode bits로 Windows ACL 또는 reparse-point 안전성을 보장한다고 주장하지 않으며, 해당 native 검증은 별도 platform gate다. group/other write가 있는 directory는 sticky bit를 이유로 예외 허용하지 않는다.

### Windows profile path

Windows에서는 `windows-profile-native.ts`가 user token의 current SID, opened-handle의 reparse/type, owner와 DACL을 확인한다. Final profile은 current SID에만 private access를 허용하고, ancestor는 다른 principal이 `DELETE`, `FILE_DELETE_CHILD`, `WRITE_DAC`, `WRITE_OWNER` 또는 generic write/all을 갖는 경우 거절한다. Missing component는 current SID를 명시한 private security descriptor와 handle inheritance disabled security attributes로 만든 뒤 다시 확인한다. Native ACL/reparse 검사나 namespace durability capability가 `unknown`이면 `setPath`, name, app identity setter를 호출하지 않는다.

Windows Koffi/Win32 실행은 이 Mac host의 테스트로 증명하지 않는다. 선택된 Windows OS/CPU에서 native module variant·PE architecture, profile ACL, reparse race와 directory/namespace durability를 별도 release evidence로 확인해야 하며, 현재 구현의 default capability gate는 그 전까지 fail closed다.

검사 실패, 비 directory, symlink, canonical spelling 불일치, filesystem 오류와 Electron read-back 불일치는 fail closed다. Profile path가 안전하다고 확인되기 전에 `mkdir` 외의 profile 적용 side effect를 시작하지 않으며, `setPath`가 시작된 뒤의 name·identity·read-back 실패는 부분 적용 fatal error로 분류한다.

## 보장 범위

이 검사는 관측 시점의 path entry와 POSIX owner/mode 조건을 보수적으로 제한하고 기존 native canonical·leaf `0700`·directory durability 검사를 유지한다. 확장 ACL, macOS inherited ACL, Windows ACL/reparse point, 다른 process가 검증 후 inode를 교체하는 경쟁, 모든 filesystem의 power-loss durability를 mode bits나 주입 filesystem test만으로 증명하지 않는다. 실제 OS와 packaged profile의 native 검증은 release gate다.

관련 보수적 POSIX 정책과 사용자 merge 후 적용 경계는 [Desktop Authentication Platform](../rules/desktop-auth-platform.md#posix-profile-ancestor-permissions)에서 관리한다.
