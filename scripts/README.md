# scripts

저장소에서 반복적으로 사용하는 생성 도구를 별도의 pnpm 프로젝트로 관리합니다.

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
