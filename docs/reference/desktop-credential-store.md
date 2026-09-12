---
type: reference
status: active
enforcement: autonomous
scope: desktop macOS and Windows credential adapters and isolated validation
last-reviewed: 2026-09-12
---

# Desktop credential store

`apps/desktop/src/backend/auth/credential-store/macos-credential-store.ts`와 `windows-credential-store.ts`의 adapter는 공통 `CredentialStore` protocol을 구현한다. 제품 main은 완전하고 유효한 trusted runtime 설정이 있을 때 OS adapter를 auth HTTP, coordinator와 같은 tuple로 구성한다. 저장 정책은 [platform](../rules/desktop-auth-platform.md), generation·writer·HTTP·복구 종료 정책은 [lifecycle](../rules/desktop-auth-lifecycle.md)과 기존 coordinator가 소유한다.

Main은 Electron에 적용·read-back 확인한 trusted config 하나를 bootstrap에 전달한다. Runtime effects의 `createDependencies(config)`가 그 config의 `userDataPath`, `environment`, exact HTTPS `apiOrigin`으로 store context를 만들고 기본 Electron `safeStorage`와 함께 OS adapter에 전달한다. Context의 `clientId`는 `"desktop"`이며 environment는 경로 구성에 안전한 소문자·숫자·하이픈 최대 32자다. Runtime 값은 renderer가 아니라 process 설정에서만 읽지만, 실제 dev/test/prod 값과 package 주입은 현재 `electron-builder.yml`에 고정되어 있지 않다. 현재 builder identity도 배포용 trusted tuple로 확정한 값이 아니다. 제품 composition entry는 OS allowlist 없이 실행되며 `darwin`은 macOS adapter, `win32`는 Windows adapter, 그 밖의 host는 `unavailable` adapter를 선택한다. `files`와 `platform` 주입은 전용 test에서 Node IO의 실패와 환경을 제어하기 위한 경계다.

## Windows capability와 packaging gate

Windows 구현은 현재 composition에 연결되어 있지만, default native capability는 ACL/SID, selected OS/CPU ABI, packaged native module, namespace durability evidence가 없어서 `unknown`으로 닫혀 있다. Windows profile capability가 `unknown` 또는 `unavailable`이면 `setPath`, name, app identity setter 전에 main의 profile preparation이 실패하고 `preparation-failed` fallback으로 간다. Profile 적용 후 store capability가 `unavailable`일 때만 safeStorage·network mutation 전에 `storageBlocked/SECURE_STORAGE_UNAVAILABLE`을 반환한다. 파일 목록 조회는 구현되어 기존 소유 임시 파일 탐색과 정리 경로에 연결되지만, capability를 활성화하지 않는다. Directory/삭제 namespace durability도 durable 구현이 완성되지 않았다. 현재는 directory handle 재검사·`FlushFileBuffers`, handle-bound rename/delete를 호출하는 후보 경로만 있고, 신규 directory·rename·delete의 durable 보장을 주장하려면 추가 구현과 별도 evidence가 필요하다. 이 Mac host의 테스트는 Windows API 호출이나 Windows login persistence를 증명하지 않는다. 별도 Windows OS/CPU ABI, DPAPI, packaged native module과 실제 profile/credential E2E도 아직 검증하지 않았다. Windows boundary dependency는 `koffi` **3.2.1**이다.

`pnpm-lock.yaml` entry만으로 Windows packaging 성공을 주장하지 않는다. `npmRebuild:false`를 유지한 채 선택된 target OS/CPU에서 `node_modules/@koromix/koffi-win32-*`의 정확한 variant와 packaged app의 PE architecture를 확인해야 한다. 모든 CPU variant를 임의로 설치하거나 지원 OS/CPU를 이 reference에서 확정하지 않는다. Electron-builder의 `.node` smart unpack은 바이너리 누락이나 잘못된 target variant를 해결하지 않으므로 package evidence는 별도 release gate다.

## Windows 파일 목록 조회

`windows-security-native.ts`는 `CreateFileW`로 연 directory HANDLE의 private owner/SID/DACL, directory type과 reparse 여부를 기존 검사로 확인한 뒤 `GetFileInformationByHandleEx`를 호출한다. 첫 호출은 `FileFullDirectoryRestartInfo`, 후속 호출은 `FileFullDirectoryInfo`이며 같은 HANDLE을 사용한다. Koffi binding은 32-bit `BOOL`, HANDLE, class, raw byte 출력 pointer와 byte 크기를 선언한다. 기존 file attribute 구조체 binding과 분리해 가변 길이 결과를 구조체 하나로 잘못 해석하지 않는다.

8-byte 정렬을 확인한 64 KiB Buffer를 호출마다 비운다. API가 실제 반환 byte 수를 제공하지 않으므로 성공한 결과에서도 header, UTF-16 byte 길이, 이름 범위, 다음 entry의 정렬과 겹침, 다음 header 공간을 확인한다. 잘못된 UTF-16, NUL, 경로 구분자, colon과 Win32 경로 alias가 되는 끝의 점·공백은 거절한다. `.`과 `..`만 제외하고 이름을 보정하지 않는다. Entry의 `NextEntryOffset=0`은 해당 buffer의 끝이며 전체 조회 종료가 아니다.

`ERROR_NO_MORE_FILES`를 확인하고 HANDLE 종료까지 성공한 뒤 전체 이름을 반환한다. 첫 호출과 후속 호출의 다른 오류, buffer 부족, parse 오류와 HANDLE 종료 실패는 throw하며 부분 결과나 빈 목록으로 바꾸지 않는다. Buffer를 늘려 재시도하지 않으므로 64 KiB로 처리하지 못하는 filesystem 결과도 사용 불가로 남는다. 이 구현이 filesystem snapshot이나 다른 process의 동시 변경 차단을 보장하지는 않는다.

`windows-credential-native.ts`가 이 결과를 `WindowsCredentialFiles.ownedTemporaries()`에 전달한다. 기존 UUID 기반 `.credential.v1.*.tmp`와 `.transition.v1.*.tmp` 선택 규칙, marker 교체 후 marker temp 정리, clear의 credential 및 소유 temp 삭제 순서는 유지한다. 목록 조회가 끝나기 전이나 실패한 경우 삭제를 시작하지 않는다. 개별 삭제의 HANDLE 기반 보안 검사도 유지하며 unrelated 파일을 정리 대상으로 확대하지 않는다.

근거는 [GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex), [FILE_FULL_DIR_INFO의 가변 길이와 정렬](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_full_dir_info), [Microsoft WIL의 목록 종료와 오류 처리](https://github.com/microsoft/wil/blob/master/include/wil/filesystem.h)다. 고정 설치본 `koffi@3.2.1`의 `doc/output.md`, `doc/pointers.md`, `index.d.ts`와 native pointer 전달 구현을 확인했다. 동기 호출 동안 Buffer의 실제 주소를 사용하는 계약과 BigInt HANDLE decode는 테스트에서 검증한다. 이는 Windows OS 실행 evidence와 구분한다.

## 파일과 결과

- `credential-record.ts`가 최대 16,384-byte strict UTF-8/JSON, exact field·version·context, canonical base64 ciphertext와 canonical refresh를 검사한다. 암호화 payload는 동일 context·version·refresh 하나이며 access·profile·pending은 저장하지 않는다.
- `macos-credential-files.ts`는 `userDataPath/auth/<environment>/`를 사용한다. UserData root와 auth directory는 현재 user 소유의 0700 directory, record/temp는 0600 regular file이어야 한다. 기존 권한을 임의로 바꾸지 않는다. 마지막 경로 요소에는 no-follow open을 사용하며 symlink·잘못된 type/owner/mode는 거절한다.
- `windows-credential-files.ts`는 같은 path layout을 사용하지만 Node mode bits를 보안 근거로 삼지 않는다. Win32 opened handle에서 reparse/type와 token current SID·owner/DACL을 확인하고, private ACL이 아니면 거절한다. Temp는 `CREATE_NEW`와 write-through로 만들고 write/flush 뒤 같은 handle의 `FileRenameInfo`로 교체한다. Native capability가 `unknown`이면 이 path는 실행되지 않는다.
- `transition.v1`에는 version·임의 local operation ID·종류만 둔다. Exclusive temp 생성→file sync→동일 directory rename→directory sync를 확인한 marker만 이 instance의 mutation 자격으로 사용한다. 재확립은 새 marker를 먼저 flush한 뒤 이전 marker temp를 제거하고 삭제 sync까지 확인한다.
- Credential 교체도 exclusive temp→file sync→rename→directory sync이며 이전 사본을 만들지 않는다. Local clear는 확립된 clear marker 아래 credential와 소유 temp를 지우고 sync한다. 이후 marker 삭제·directory sync는 별도 port 호출이다.

| 관측                                                                      | Port 결과와 호출자의 후속 처리                                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Marker/소유 temp 없음, 보호 backend의 시험 암복호화 성공, credential 없음 | `empty`                                                                                                                                         |
| Marker/소유 temp 없음, 정상 record 복호화·payload 검증 성공               | `ready`와 refresh 하나                                                                                                                          |
| Marker 또는 소유 temp 존재, record/payload 손상                           | `recovery-required`; marker가 있으면 backend 조회·복호화하지 않는다. Coordinator가 clear와 최종 상태를 결정한다.                                |
| 권한/type/owner/symlink 문제, backend 거절·복호화 예외                    | `unavailable`; 정상 ciphertext를 임의로 삭제하거나 평문 fallback을 사용하지 않는다.                                                             |
| 교체 호출 전 실패                                                         | `failed`; 성공으로 publish하지 않는다.                                                                                                          |
| Rename 호출 이후 실패 또는 marker 삭제 결과/flush 불명                    | `unknown`; 기존 credential operations가 marker 재확립을 시도한다. 재확립 실패는 local clear 미확인이며 다음 실행의 복원 차단을 보장하지 않는다. |

## 검증 명령과 범위

Repository root에서 실행한다.

```sh
pnpm --filter @ldb/desktop exec vitest run src/backend/auth/credential-store/windows-credential-native.test.ts src/backend/auth/credential-store/windows-credential-store.test.ts src/backend/auth/windows-security-native.test.ts src/backend/auth/credential-store/macos-credential-store.test.ts src/backend/auth/credential-store/macos-credential-lifecycle.test.ts
pnpm --filter @ldb/desktop exec tsc --noEmit -p scripts/credential-store-native/tsconfig.json --composite false
node apps/desktop/scripts/credential-store-native.mjs --prepare-only
node apps/desktop/scripts/credential-store-native.mjs
node apps/desktop/scripts/credential-store-native.mjs --fail-after-write
pnpm --filter @ldb/desktop run --sequential '/^(test|lint|build)$/'
```

전용 Vitest는 소유한 `mkdtemp` 아래 실제 Node IO에 실패·지연만 주입하고 safeStorage는 합성 double을 사용한다. 파일/handle 정리, marker·교체·삭제 실패, marker 재확립 실패와 정상 재시작, 저장 중 취소·늦은 응답·새 writer 차단을 관찰한다. 초기 Red는 module 부재로 collection에 실패했으며 실제 assertion 통과는 Green evidence다. Marker 재확립 회귀는 별도 assertion 실패를 재현한 뒤 수정했다.

Native runner의 `--prepare-only`는 bundle 생성·정리만 하며 Electron/Keychain을 호출하지 않는다. 실제 mode는 고유 시험 app name·profile을 만들고 exact Keychain service/account가 search list와 default Keychain에 없음을 먼저 확인한다. 첫 await 이전 `app.setName`으로 시험 identity를 고정하며 ready 이후에만 safeStorage를 호출한다. 서로 다른 네 process에서 합성 R0 저장, 재시작·R1 교체, marker 생성, 복호화 없는 재시작 정리를 검증한다. 현재 default가 바뀌면 진행을 중단한다. 실패 또는 30초 제한에 도달하면 child process group을 종료하며 OS prompt를 자동 승인하지 않는다.

`--fail-after-write`는 별도 고유 identity에서 저장 직후 의도적으로 실패한다. 기대 결과는 exit 1, `injectedFailure:true`, `cleanupConfirmed:true`이며 정상 검증의 실패로 숨기지 않고 실패 후 정리 evidence로 구분한다.

종료 후 이번 실행의 exact service/account만 기록한 Keychain에서 삭제하고 default·search list의 부재를 확인한다. 기본 Keychain·search list·ACL은 변경하지 않는다. Child process group과 profile/bundle의 종료·부재를 확인하며 정리가 불명확하면 실패하고 local owner manifest를 남긴다. 비밀번호 조회 flag와 raw child/OS 오류 출력은 사용하지 않는다. 실제 실행 결과와 미실행 항목은 해당 PR의 evidence를 따른다.

## Bootstrap 연결 조건과 남은 gate

제품 main은 single-instance lock 전에 app identity와 private userData profile을 적용하고, `app.ready` 이후 접근 안내를 표시한 뒤 runtime effects가 기본 Electron safeStorage를 사용하는 dependency를 생성하게 한다. 설정이 없거나 잘못되면 adapter, auth HTTP와 coordinator를 생성하지 않는다. 고정된 dev/test/prod profile·API origin·배포 identity와 private root 권한의 실제 값은 아직 확인하지 않았다. OS prompt는 동기 safeStorage 호출을 막을 수 있으며 JavaScript timer로 취소된다고 가정하지 않는다. 실제 OAuth, packaged app과 production 저장 검증은 별도 통합 범위다.

확인한 고정 조합은 Electron **39.8.10**, Node **22.22.1**, libuv **1.51.0**이다. [Electron DEPS](https://raw.githubusercontent.com/electron/electron/v39.8.10/DEPS)와 설치 runtime을 대조했다. [Node의 libuv Apple 구현](https://raw.githubusercontent.com/nodejs/node/v22.22.1/deps/uv/src/unix/fs.c)은 `FileHandle.sync()` 경로에서 `F_FULLFSYNC`, 실패 시 `F_BARRIERFSYNC`, 다시 실패 시 `fsync`를 사용한다. JavaScript 성공은 선택된 fallback을 알려 주지 않으므로 실제 filesystem의 directory durability·전원 손실 보장을 증명하지 않는다.

Native 합성 저장 성공도 Keychain 잠금/사용자 거절, 실제 서명·공증·다른 bundle·업데이트/백업 복원 검증을 대체하지 않는다. 출시 filesystem·OS·identity에서 필요한 gate가 해소되기 전 로그인 유지가 검증됐다고 표시하지 않는다. 이 adapter는 OS profile rollback·동일 user malware·physical erase를 보장하지 않는다.
