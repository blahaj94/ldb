# scripts

저장소에서 반복적으로 사용하는 local 도구입니다. 새 dependency 없이 Node.js와 기존 Git·GitHub CLI·pnpm command를 사용합니다.

## `start-task`

기존 OPEN Issue 확인, `origin/main` fetch, Issue별 branch와 worktree 생성을 한 번에 실행합니다. Git와 인증된 GitHub CLI가 필요하며, 대상 repository root에서 실행합니다.

```bash
node scripts/start-task.mjs 123 ../ldb-worktrees/issue-123
```

`123`은 실제 Issue 번호로 바꿉니다. 두 번째 인자는 아직 존재하지 않는 경로이며, 공백이 있으면 quote합니다. 생성 branch는 `codex/issue-123`이고, base는 이번 fetch로 받은 main commit입니다. 현재 checkout의 미반영 변경은 포함하지 않습니다.

Root alias `pnpm start-task 123 ../ldb-worktrees/issue-123`도 제공합니다. 새 checkout에서는 pnpm이 dependency install을 먼저 수행할 수 있으므로, 준비만 할 때는 위 Node command를 사용합니다.

Issue 제목·URL, branch, 절대 worktree 경로, base SHA를 출력합니다. 기존 branch나 경로는 재사용하거나 덮어쓰지 않으며, 조회·fetch·생성 실패 시 non-zero로 종료합니다. 생성 후 출력된 worktree로 이동해 작업합니다.

Issue 작성, preflight, approval과 dependency 판단은 [`change-control.md`](../docs/rules/change-control.md)를 따릅니다. 이 command는 GitHub 내용을 변경하거나 install·commit·push를 실행하지 않습니다. 경로 충돌이나 생성 실패가 있으면 원인을 확인하고 필요한 정리는 native Git command로 수행합니다.

```bash
node --test scripts/test/start-task.test.mjs
node --check scripts/start-task.mjs
```

## Native validation

변경 범위에 맞는 command를 선택합니다. 아래 [pnpm regex selector와 `--sequential`](https://pnpm.io/cli/run)은 선택한 script를 이름순으로 하나씩 실행하며 실패 시 non-zero로 종료합니다. 별도 validation runner나 dependency가 필요하지 않습니다.

| 변경 범위 | Repository root에서 실행할 command |
| --- | --- |
| Desktop | `pnpm --filter @ldb/desktop run --sequential '/^(test\|lint\|build)$/'` |
| Web | `pnpm --filter @ldb/web run --sequential '/^(lint\|build)$/'` |
| PR review tooling | `pnpm run --sequential '/^(test\|typecheck):pr-review$/'` |
| Task 준비 tooling | 위 `node --test`와 `node --check` command |

Desktop `build`는 `typecheck`를 포함하므로 위 조합에서 별도로 반복하지 않습니다. Web `build`도 `tsc -b`를 포함합니다. 빠른 feedback이 필요할 때는 기존 개별 `test`, `lint`, `typecheck` command를 먼저 실행할 수 있습니다. 여러 범위를 변경했다면 해당 행을 함께 검증합니다.

Root `test`와 API의 빈 script는 성공 evidence가 아닙니다. Web에는 별도 test script가 없으며, 문서만 변경할 때 app build를 반복할 필요는 없습니다. 실제 validation 범위와 실행하지 못한 항목은 [`testing.md`](../docs/rules/testing.md)에 따라 PR에 기록합니다.

## `create-app`

새로운 API 애플리케이션 workspace를 생성합니다.

저장소 루트에서 실행:

```bash
pnpm create-app --name @ldb/api
```

`-n` 축약 옵션도 지원합니다.

```bash
pnpm create-app -n @ldb/api
```

스크립트 프로젝트의 생성기를 직접 실행할 수도 있습니다.

```bash
node scripts/create-app.mjs --name @ldb/api
```

패키지명은 `@ldb/<app-name>` 형식이어야 하며, 앱 이름은 소문자 영문·숫자와 하이픈으로 구성해야 합니다.

```bash
pnpm create-app --name @ldb/party-api
```

생성 결과:

```text
apps/party-api/
├── src/
└── package.json
```

생성되는 `package.json`의 기본값:

```json
{
  "name": "@ldb/party-api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "",
    "build": "",
    "test": "",
    "typecheck": "tsc --noEmit",
    "lint": "eslint ."
  }
}
```

`dev`, `build`, `test` 스크립트는 API 서버 프레임워크를 정한 뒤 구현합니다.

### 안전 규칙

- 기존 `apps/<app-name>` 디렉터리가 있으면 생성하지 않고 종료합니다.
- 기존 파일을 덮어쓰지 않습니다.
- 생성기 자체는 `pnpm install`을 자동 실행하지 않습니다.
- 생성 후 workspace 인식 여부는 다음 명령으로 확인할 수 있습니다.

```bash
pnpm list -r --depth -1
```

npm으로 루트 명령을 실행하는 경우에는 스크립트 인자 앞에 `--`를 추가합니다.

```bash
npm run create-app -- --name @ldb/api
```

구현은 같은 디렉터리의 [`create-app.mjs`](./create-app.mjs)에 있습니다.
