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

## `agent-usage`

Codex local usage record를 Issue 작업 범위로 집계하고, PR이 merge되면 연결된 Issue에 사용량과 실제 agent model/effort를 게시합니다. Node.js 22 이상, Git와 인증된 GitHub CLI를 사용하며 dependency install이나 model 호출은 없습니다.

Issue worktree에서 작업을 시작할 때 아래 command를 실행합니다. Root task는 `CODEX_THREAD_ID`, 시작점은 현재 관측된 마지막 turn을 사용합니다. 이전 turn부터 시작한 작업이면 `turns`로 경계를 확인하고 `--from-turn`을 지정합니다.

```bash
node scripts/agent-usage.mjs begin --issue 123
node scripts/agent-usage.mjs turns
node scripts/agent-usage.mjs begin --issue 123 --thread ROOT_TASK_ID --from-turn START_TURN_ID
```

`begin`은 같은 시작 범위에 대해 재실행할 수 있지만 기존 범위를 덮어쓰지 않습니다. Manifest는 Git common directory 아래 `agent-usage/issue-123.json`에 저장하므로 worktree끼리 공유하며 tracked source에 포함되지 않습니다. 다른 Issue가 같은 root task를 재사용하면 새 시작 turn을 기록합니다. 한 turn에 여러 Issue 작업을 섞지 않고, 무관한 후속 turn은 종료 범위 또는 반복 가능한 `--exclude-turn`으로 제외합니다.

최종 변경을 push하고 모든 subagent가 완료된 뒤 snapshot을 PR comment에 저장합니다. 대상 PR은 `Closes #123` 등으로 해당 Issue와 연결되어 있어야 하며, local HEAD와 PR head가 같아야 합니다.

```bash
node scripts/agent-usage.mjs snapshot --issue 123 --pr 124 --publish
```

`--publish`를 생략하면 GitHub 조회와 local snapshot 저장만 수행합니다. `--json`은 Markdown 대신 공개 가능한 aggregate JSON을 출력합니다. 게시할 Markdown과 검증용 JSON을 합친 snapshot comment가 GitHub의 65,536자 한도를 넘으면 local snapshot을 유지하고 게시 전에 크기 초과 오류를 반환합니다. 최초 종료 범위는 command 실행 시각까지의 마지막 root turn이며, `--through-turn END_TURN_ID`와 `--until UTC_TIMESTAMP`로 지정할 수 있습니다. 재실행은 저장된 종료 시각·turn·제외 turn을 유지합니다. 다른 Issue의 시작 범위를 포함하려 하면 실패하므로 앞선 Issue의 종료를 명시합니다.

추가 작업 후 PR head가 변경되면 push 후 `snapshot --issue 123 --pr 124 --refresh --publish`로 현재까지 범위를 명시적으로 확장합니다. `--refresh`와 종료 옵션을 함께 주면 명시한 옵션이 우선합니다. Merge된 PR의 backfill 재시도에는 `--refresh` 없이 저장된 범위를 사용합니다.

로그는 기본적으로 `$CODEX_HOME/sessions` 또는 `~/.codex/sessions`에서 읽으며 `--sessions-dir PATH`로 바꿀 수 있습니다. `--repo OWNER/REPO`와 `--thread ROOT_TASK_ID`로 repository와 root task를 명시할 수 있습니다. Repository는 대소문자를 구분하지 않으며 기존 mixed-case manifest도 재사용합니다. `turns`의 내부 ID 출력과 manifest는 local 경계 선택용이며 GitHub 보고에는 포함하지 않습니다.

집계는 response별 delta를 dedup하고 root turn에 연결된 descendant만 재귀적으로 포함합니다. 입력·캐시 입력·출력·reasoning·전체·캐시 입력 제외를 구분하며, reasoning은 출력의 일부이므로 다시 더하지 않습니다. 모델 또는 기록 누락, 잘린 로그, 누적 counter 불일치, 미완료 subagent는 고정된 경고와 불완전 집계로 표시하고 exit code `1`을 반환합니다. 이는 snapshot 시점의 관측량으로, 이후 마무리 응답과 보고 command 자체를 포함한 최종 과금 총량이 아닙니다.

`.github/workflows/agent-usage-report.yml`이 same-repository PR의 merge event를 처리합니다. Trusted default branch의 코드로 snapshot 작성자·schema·head·Issue 연결을 검증하고, PR별 marker가 있는 Issue comment를 게시하거나 갱신합니다. 단순 close와 fork PR은 제외합니다. Snapshot이 없거나 유효하지 않으면 수치 없이 사유를 게시하고 실행을 실패로 남겨 재시도할 수 있습니다. 다른 작성자의 comment는 덮어쓰지 않습니다.

재시도는 workflow의 수동 실행(`pr_number`) 또는 아래 command로 수행합니다. 이미 merge된 PR을 backfill할 때는 작업 시작 turn을 먼저 지정하고 `snapshot --until`에 merge 시각 이하의 UTC 시각을 넘깁니다.

```bash
node scripts/agent-usage.mjs publish --repo OWNER/REPO --pr 124
```

Workflow가 default branch에 반영된 이후부터 자동 게시가 동작합니다. GitHub runner는 local Codex 로그를 읽을 수 없으므로 merge 전에 Worker가 snapshot command를 실행해야 합니다. 추가 Secret, 외부 서버, polling process는 사용하지 않습니다.

```bash
node --test scripts/agent-usage/test/*.test.mjs
node --check scripts/agent-usage.mjs
node --check scripts/agent-usage/collect.mjs
node --check scripts/agent-usage/report.mjs
node --check scripts/agent-usage/github.mjs
```

## Native validation

변경 범위에 맞는 command를 선택합니다. 아래 [pnpm regex selector와 `--sequential`](https://pnpm.io/cli/run)은 선택한 script를 이름순으로 하나씩 실행하며 실패 시 non-zero로 종료합니다. 별도 validation runner나 dependency가 필요하지 않습니다.

| 변경 범위 | Repository root에서 실행할 command |
| --- | --- |
| Desktop | `pnpm --filter @ldb/desktop run --sequential '/^(test\|lint\|build)$/'` |
| Web | `pnpm --filter @ldb/web run --sequential '/^(lint\|build)$/'` |
| PR review tooling | `pnpm run --sequential '/^(test\|typecheck):pr-review$/'` |
| Task 준비 tooling | 위 `node --test`와 `node --check` command |
| Agent 사용량 tooling | 위 `agent-usage`의 `node --test`와 `node --check` command |

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
