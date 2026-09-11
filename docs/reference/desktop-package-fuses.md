---
type: reference
status: active
scope: apps/desktop electron-builder packaging fuse configuration
last-reviewed: 2026-09-12
---

# Desktop 패키지의 Node 진입점 fuse

`apps/desktop/electron-builder.yml`의 root `electronFuses`는 electron-builder가
Electron executable에 기록하는 두 V1 fuse를 명시적으로 끈다.

| 설정 | 값 | 차단하는 진입점 |
| --- | --- | --- |
| `enableNodeOptionsEnvironmentVariable` | `false` | packaged Electron의 `NODE_OPTIONS`와 `NODE_EXTRA_CA_CERTS` 환경변수 사용 |
| `enableNodeCliInspectArguments` | `false` | `--inspect`, `--inspect-brk` 등의 Node CLI inspector 인자와 `SIGUSR1`에 의한 main inspector 초기화 |

이 설정은 개발 중인 Electron 실행이나 일반 Node process의 환경변수를 바꾸지
않는다. electron-builder가 패키징할 때 기존 `@electron/fuses` 경로로 fuse를
기록하도록 하는 packaging policy이며, 두 값은 기본값에 의존하지 않고 source
configuration에 직접 적는다.

## Configuration regression test

`apps/desktop/scripts/desktop-package-fuses.test.mjs`는 현재 desktop project를
builder의 실제 `getConfig(projectDir, null, null)`로 읽는다. 이어서
electron-builder가 함께 제공하는 app-builder-lib 26.15.3의
`validateConfiguration`을 호출해 해당 버전의 `scheme.json` schema가 전체
configuration과 두 fuse field를 수용하는지 확인한 뒤 두 값을 모두 `false`로
검사한다. 새 dependency를 추가하거나 builder 설정을 wrapper·afterPack hook으로
변환하지 않는다.

Focused test:

```bash
pnpm --filter @ldb/desktop exec vitest run scripts/desktop-package-fuses.test.mjs
```

Desktop source/config 검증과 aggregate build의 기본 경로는 다음과 같다.

```bash
pnpm --filter @ldb/desktop run --sequential '/^(test|lint|build)$/'
pnpm --filter @ldb/desktop run format:check
git diff --check
```

## Native release gate

builder loader와 schema가 통과하는 것은 source configuration의 적합성 evidence다.
그 결과만으로 제품 executable에 fuse가 실제 기록됐거나 inspector가 닫혔다고
주장하지 않는다. 다음은 출시할 OS, architecture, package와 서명 조건이 정해진
후 별도 native gate로 남긴다.

- 실제 packaged Electron executable의 fuse readback
- 실제 executable 실행에서 `--inspect`, `--inspect-brk`, `NODE_OPTIONS`,
  `NODE_EXTRA_CA_CERTS`, `SIGUSR1` 처리 확인
- 실제 서명·공증·제품 package 생성과 설치/OS 등록
- credential store와 실제 user profile을 사용하는 실행

이번 configuration test에서는 Electron/packaged app을 실행하지 않고, 위 native
gate·credential·서명·공증도 수행하지 않는다.
