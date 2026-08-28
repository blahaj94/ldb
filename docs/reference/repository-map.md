---
type: reference
status: active
enforcement: autonomous
scope: repository
last-reviewed: 2026-08-28
---

# Repository Map

이 file은 현재 repository의 사실을 설명하는 Reference document다. AI가 code와 config 변경에 맞춰 자율적으로 갱신한다.

## Workspace

- Package manager: `pnpm@11.23.0`
- Workspace pattern: `apps/*`, `packages/*`
- Root package: `@ldb`
- Root type: ESM

## Applications

### `apps/api`

- Package: `@ldb/api`
- Type: ESM
- 현재 `dev`, `build`, `test` script는 비어 있다.
- 선언된 validation script: `typecheck`, `lint`
- 현재 tracked source implementation은 없다.

### `apps/web`

- Package: `@ldb/web`
- Stack: React, TypeScript, Vite
- Command:
  - `pnpm --filter @ldb/web dev`
  - `pnpm --filter @ldb/web build`
  - `pnpm --filter @ldb/web lint`
  - `pnpm --filter @ldb/web preview`

### `apps/desktop`

- Package: `@ldb/desktop`
- Stack: Electron, React, TypeScript, electron-vite
- Process boundary: `main`, `preload`, `renderer`
- Command:
  - `pnpm --filter @ldb/desktop dev`
  - `pnpm --filter @ldb/desktop typecheck`
  - `pnpm --filter @ldb/desktop lint`
  - `pnpm --filter @ldb/desktop build`

## Repository tooling

- `scripts/create-app.mjs`: 새 app workspace 생성 script
- `pnpm create-app`: root에서 생성 script 실행
- Root `test` script는 현재 placeholder이며 성공하는 validation command가 아니다.

## Generated and dependency output

다음 directory는 일반적인 architecture context로 읽지 않는다. 관련 Issue가 직접 다룰 때만 확인한다.

- `node_modules`
- `dist`
- `out`
- build artifact와 cache

## Update trigger

다음 변경이 생기면 이 Reference document를 같은 PR에서 갱신한다.

- Workspace, app, package 추가·삭제·이름 변경
- Runtime 또는 주요 framework 변경
- 표준 command 변경
- Process boundary 또는 source root 변경
