# scripts

저장소에서 반복적으로 사용하는 local 도구입니다. 새 dependency 없이 Node.js와 기존 Git·GitHub CLI·pnpm command를 사용합니다.

## `start-task`

Project 작업을 지정받았으면 먼저 [목표별 계획과 작업 착수](../docs/rules/task-planning.md)에 따라 해당 목표와 작업, 연결된 결정을 읽고 실행 Issue를 재사용하거나 분해해 확정합니다. 이 명령은 그 다음 단계에서 사용합니다. `project` 인자는 GitHub Project 번호가 아니라 아래 workspace 범위입니다.

기존 OPEN Issue 확인, `origin/main` fetch, Issue별 branch와 worktree 생성을 한 번에 실행합니다. Git와 인증된 GitHub CLI가 필요하며, 대상 repository root에서 실행합니다.

```bash
node scripts/start-task.mjs api 123 fix-character-search ../ldb-worktrees/api-123-fix-character-search
```

인자 순서는 `<project> <Issue 번호> <description> <새 worktree 경로>`입니다. 위 명령은 `api-123-fix-character-search` 브랜치를 만듭니다. `123`은 현재 저장소의 실제 OPEN Issue 번호로 바꿉니다. 마지막 인자는 아직 존재하지 않는 경로이며, 공백이 있으면 quote합니다. Base는 이번 fetch로 받은 main commit이며 현재 checkout의 미반영 변경은 포함하지 않습니다.

`project`에는 `api`, `desktop`, `web`, `ui`, `cross`, `repo` 중 하나를 전달합니다. 작업 범위 선택과 통합·Worker 브랜치 기준은 [브랜치 명명 규칙](../docs/rules/change-control.md#브랜치-명명-규칙)을 따릅니다. `description`은 `fix-character-search`처럼 변경 동사로 시작하는 소문자 설명을 정합니다. 스크립트는 소문자로 시작하고 소문자·숫자를 하이픈 하나로 연결하는 형식을 검증하며, 동사 의미나 Issue 범위의 적합성은 담당자가 판단합니다.

기존 두 인자 명령은 사용법 오류로 거절합니다. 기존 브랜치·worktree를 바꾸거나 지우지 않으며, 같은 이름의 로컬 브랜치나 대상 경로가 이미 존재하면 생성을 거절합니다.

Root alias `pnpm start-task api 123 fix-character-search ../ldb-worktrees/api-123-fix-character-search`도 제공합니다. 새 checkout에서는 pnpm이 dependency install을 먼저 수행할 수 있으므로, 준비만 할 때는 위 Node command를 사용합니다.

Issue 제목·URL, branch, 절대 worktree 경로, base SHA를 출력합니다. 기존 branch나 경로는 재사용하거나 덮어쓰지 않으며, 조회·fetch·생성 실패 시 non-zero로 종료합니다. 생성 후 출력된 worktree로 이동해 작업합니다.

Issue 작성, preflight, approval과 dependency 판단은 [`change-control.md`](../docs/rules/change-control.md)를 따릅니다. 이 command는 GitHub 내용을 변경하거나 install·commit·push를 실행하지 않습니다. 경로 충돌이나 생성 실패가 있으면 원인을 확인하고 필요한 정리는 native Git command로 수행합니다.

```bash
node --test scripts/test/start-task.test.mjs
node --check scripts/start-task.mjs
```

## `format-date`

UTC ISO 시각을 한국 시간(`Asia/Seoul`)의 `2026년 9월 9일 00시 35분` 형식으로 출력합니다. 인자를 생략하면 현재 시각을 사용합니다.

```bash
node scripts/format-date.mjs '2026-09-08T15:35:00Z'
node scripts/format-date.mjs
```

입력은 `YYYY-MM-DDTHH:mm:ssZ`이며 소수 초 1–3자리를 허용합니다. 잘못된 날짜나 시간대 없는 값은 오류로 거절합니다. `formatDate(timestamp)`를 import해 재사용할 수 있습니다.

검증: `node --test scripts/test/format-date.test.mjs`, `node --check scripts/format-date.mjs`.

## Native validation

변경 범위에 맞는 command를 선택합니다. 아래 [pnpm regex selector와 `--sequential`](https://pnpm.io/cli/run)은 선택한 script를 이름순으로 하나씩 실행하며 실패 시 non-zero로 종료합니다. 별도 validation runner나 dependency가 필요하지 않습니다.

| 변경 범위 | Repository root에서 실행할 command |
| --- | --- |
| API | `pnpm --filter @ldb/api run --sequential '/^(lint\|test\|typecheck)$/'` |
| API auth database | 위 API command와 `pnpm --filter @ldb/api test:database` |
| Desktop | `pnpm --filter @ldb/desktop run --sequential '/^(test\|lint\|build)$/'` |
| Web | `pnpm --filter @ldb/web run --sequential '/^(lint\|build)$/'` |
| PR review tooling | `pnpm run --sequential '/^(test\|typecheck):pr-review$/'` |
| Task 준비 tooling | 위 `node --test`와 `node --check` command |

Desktop `build`는 `typecheck`를 포함하므로 위 조합에서 별도로 반복하지 않습니다. Web `build`도 `tsc -b`를 포함합니다. 빠른 feedback이 필요할 때는 기존 개별 `test`, `lint`, `typecheck` command를 먼저 실행할 수 있습니다. 여러 범위를 변경했다면 해당 행을 함께 검증합니다.

API의 `test`는 `build`를 먼저 실행해 `dist`를 새로 만든 뒤 `.test-dist` compile과 test를 수행합니다. 위 API 조합은 이 build를 포함하며, 단독 `pnpm --filter @ldb/api test`도 최신 production output을 검증합니다. Root `test`는 성공 evidence가 아닙니다. Web에는 별도 test script가 없으며, 문서만 변경할 때 app build를 반복할 필요는 없습니다. 실제 validation 범위와 실행하지 못한 항목은 [`testing.md`](../docs/rules/testing.md)에 따라 PR에 기록합니다.

Schema First 작성·생성·적용 순서는 [`database-development.md`](../docs/reference/database-development.md)를 따른다. `db:migrate:generate`는 현재 EntitySchema와 접속한 개발 DB를 비교해 compiled ESM 계약의 Migration source를 생성하며 DB를 변경하지 않는다.

API의 `test:database`는 Docker daemon이 없거나 고정 image·native platform을 검증할 수 없으면 skip하지 않고 실패합니다. Run마다 생성한 credential, `127.0.0.1` dynamic port, ownership label이 붙은 container와 named volume만 사용하며 정상·오류·timeout·처리 가능한 signal 뒤 exact resource 부재를 확인합니다. 자원을 만들기 전에 stdout에 secret이나 연결 정보가 없는 recovery run ID와 exact container·volume 이름을 기록합니다.

`SIGKILL`, host crash, Docker daemon 장애 뒤 자원이 남으면 출력된 exact 이름을 `docker container inspect NAME --format '{{ index .Config.Labels "com.ldb.database-test.run" }}'`과 `docker volume inspect NAME --format '{{ index .Labels "com.ldb.database-test.run" }}'`로 각각 확인합니다. 두 결과가 출력된 run ID와 정확히 같을 때만 `docker rm --force NAME`과 `docker volume rm --force NAME`으로 회수합니다. 일치하지 않거나 inspect 자체가 실패하면 삭제하지 않습니다. 이 command는 운영 database에 사용하지 않습니다.

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
