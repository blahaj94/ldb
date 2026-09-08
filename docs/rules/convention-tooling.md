---
type: rule
status: active
enforcement: approval-required
scope: repository handwritten source, tests, scripts and tooling
last-reviewed: 2026-09-08
rationale: 기계적으로 확인·정렬할 수 있는 convention 작업은 승인된 도구에 맡기고, 의미·책임·동작 보존은 사람의 판단으로 분리한다.
evidence: "https://github.com/blahaj94/ldb/pull/163#issuecomment-5582992995"
exceptions: 기존 active 도구 책임 원칙은 승인된 config와 현재 설정 범위에만 적용하며, 공통 설정 도입 기준은 PR #165의 승인과 아래 별도 lifecycle을 따른다.
review-after: 사용자 승인·merge 후 서로 다른 app 또는 tooling의 적용 PR 3개에서 출력 수렴, 재작업, 검토 부담을 확인한다.
---

# Convention 도구 적용

이 문서는 PR #163의 사용자 명시 승인·merge를 반영한 active 도구 책임 원칙을 정의한다. 도구가 충분히 판단할 수 있는 표기와 정적 검사는 native command로 처리하고, 의미·이름·처리 단계·함수 책임·평가와 오류 보존은 편집 담당과 Reviewer가 판단한다. 공통 설정·dependency·CI의 도입은 아래 PR #165에서 별도로 승인된 계약을 따른다.

도구로 충분한 수정만을 위해 별도 AI 작성자나 조사자를 배정하지 않는다. 기존 편집 담당이 native CLI를 실행하되, 필요한 의미 판단·독립 review·기존 checkout 소유권·validation 책임은 생략하지 않는다.

## 공통 설정 도입의 승인 상태와 우선순위

공통 설정 도입 기준은 [PR #165의 사용자 명시 승인](https://github.com/blahaj94/ldb/pull/165#issuecomment-5583974743)과 선행 merge를 반영한 `active` Rule이다. Rule-only PR이 먼저 merge되어 [Issue #164의 구현 preflight](https://github.com/blahaj94/ldb/issues/164#issuecomment-5584006578)에 따라 별도 구현 PR에서 공통 설정·dependency·CI를 구현하고 검증한다. 최종 구현 결과는 사용자가 merge한다. 이 승인 사실이 실제 검사·구현 완료를 뜻하지는 않는다.

승인 후 formatter가 적용되는 범위에서는 사용자가 선택한 대로 Prettier 출력을 기준으로 맞춘다. 기존 수동 체인 줄바꿈이나 여러 줄 template의 여는 백틱 위치가 Prettier 출력과 다르면, formatter 결과를 사람이 되돌리거나 다시 설계하지 않는다. 다만 문자열 내부의 값·개행·공백, 생성 함수의 책임, 의미별 빈 줄과 조건 이름, 평가 시점은 도구 출력이 약화시키지 않는지 별도로 확인한다.

기존 승인된 두 예외는 [`convention-exceptions-proposal.md`](convention-exceptions-proposal.md)의 active 기준을 따른다. PR #161의 사용자 승인과 merge는 그 두 예외의 lifecycle만 확정하며, 공통 설정 도입 기준의 승인 evidence를 대신하지 않는다.

## 도구가 맡는 일

Prettier는 설정된 파일 범위의 순수한 layout을 정리한다. 줄바꿈, 들여쓰기, 따옴표, 세미콜론, trailing comma와 같은 formatter 출력이 대상이다. Prettier는 짧은 `if`에 중괄호를 추가하지 않고, 의미별 빈 줄·boolean 이름·함수 책임·객체 인자의 역할을 판단하지 않는다. `--write`는 승인된 설정과 glob 범위에서만 사용한다.

ESLint·Oxlint는 현재 설정된 rule과 검증된 fixer의 범위만 사용한다. ESLint의 `curly`처럼 실제 설정에 명시되고 대상 파일에서 fixer 결과가 검증된 rule은 허용된 자동수정으로 기록할 수 있다. 현재 설정에 없는 `curly`, naming rule, custom rule, 새 plugin은 이 문서만으로 도입하지 않는다. 기존 Oxlint를 이 요청만으로 ESLint로 교체하지 않으며, Oxlint를 ESLint나 Prettier의 임의 대체로 사용하지 않는다.

다음은 도구에 맡기지 않는다.

- 조건의 의미, boolean 극성, nullish와 falsey의 계약, 검사 결과의 합성
- 처리 단계와 의미별 빈 줄, helper·함수 경계와 책임, 함수 입력의 역할
- property read, getter, short-circuit, 외부 호출, 시간·lock·취소 확인의 평가 시점과 횟수
- 오류 종류·우선순위, cleanup·rollback, 반환값·객체 identity, 문자열 내부 값과 개행

이 판단이 필요한 변경은 [`convention.md`](../../convention.md)와 [`code-expression.md`](code-expression.md)의 기존 기준 및 변경 절차를 따른다.

## 공통 설정 도입 기준

```yaml
status: active
enforcement: approval-required
rationale: root와 모든 프로젝트가 같은 ESLint·Prettier 명령과 보존 경계를 사용하도록 공통 소유권과 검증 순서를 정한다.
evidence: "https://github.com/blahaj94/ldb/pull/165#issuecomment-5583974743"
exceptions: 이 기준은 PR #163의 active 역할 원칙을 유지하며, 승인된 config/version/glob/ignore와 기존 Oxlint 보조 검사의 책임을 임의로 넓히지 않는다.
review-after: Draft PR 승인·merge 후 전체 프로젝트의 lint·format check와 첫 formatter diff 2~3건에서 누락·재작업·검토 부담을 확인한다.
```

다음 공통화는 Issue #164의 Rule-only PR #165에서 승인된 기준이다. 구현에서는 root가 공통 소유자가 되는 flat ESLint config, Prettier config와 ignore를 두고 root와 `apps/api`, `apps/desktop`, `apps/web`, `packages/ui`, 그리고 workspace에 등록하지 않은 `scripts` 실행 범위를 같은 명령 계약으로 연결한다. `scripts/package.json`의 workspace 등록 여부는 바꾸지 않는다.

공통 명령의 역할은 다음과 같다.

- `lint`: 비수정 ESLint 검사. 모든 프로젝트의 기본 lint 명령으로 사용한다.
- `lint:fix`: 승인된 ESLint fixer만 실행한다. formatter를 ESLint plugin 안에서 중복 실행하지 않는다.
- `format`: 승인된 범위의 Prettier 출력으로 정렬한다.
- `format:check`: 파일을 수정하지 않고 같은 설정의 Prettier 결과를 확인한다.

root와 각 프로젝트 command는 실행 cwd와 무관하게 동일한 config 탐색·glob·ignore 결과를 사용해야 한다. `apps/desktop`의 기존 `singleQuote: true`, `semi: false`, `printWidth: 100`, `trailingComma: none`을 공통 Prettier 기준으로 사용하고, `embeddedLanguageFormatting: off`로 문자열 내부 source나 template 내용을 formatter가 다시 작성하지 않게 한다. Prettier의 출력과 기존 수동 예시가 충돌하면 승인된 formatter 결과를 기준으로 맞추되 문자열 값·개행·공백과 의미 판단은 별도로 보존한다.

ESLint는 JavaScript와 TypeScript의 recommended 검사, Node·browser·React 환경을 분리해 구성한다. `curly: ["error", "all"]`을 명시하고 `eslint-config-prettier`를 마지막에 배치해 formatter와 충돌하는 stylistic rule을 끈다. 승인된 개발 도구 역할과 도입 시 확인한 lockfile 조합은 다음과 같다. 정확한 pin과 설치 위치는 구현 preflight에서 확인하며, 이 표는 성공 검증을 의미하지 않는다.

| 역할 | 도구 | 근거·경계 |
| --- | --- | --- |
| ESLint core | `eslint@9.39.5`, `@eslint/js@9.39.5` | 현재 API·Desktop이 사용하며 flat config의 공통 기반 |
| TypeScript parser/rules | `typescript-eslint@8.69.0` | ESLint 9와 TypeScript 5.9·6.0 계열 peer 범위 확인. 각 app compiler/runtime은 유지 |
| Formatter | `prettier@3.9.6`, `eslint-config-prettier@10.1.8` | Desktop의 기존 formatter와 충돌 정리 역할 |
| Environment | `globals@16.5.0` | Node·browser global 구분 |
| React rules | `eslint-plugin-react@7.37.5`, `eslint-plugin-react-hooks@7.1.1`, `eslint-plugin-react-refresh@0.4.26` | Desktop의 기존 유효 rule을 보존하고 Web/UI 적용 전 결과를 비교 |

공통 root 개발 dependency의 `typescript@6.0.2`는 parser·lint tooling 전용이다. API·Desktop·Web·UI의 compiler/runtime TypeScript version을 올리거나 교체하는 제안이 아니며, `typescript-eslint`의 TypeScript peer 지원 범위와 각 app의 실제 compiler 역할을 같은 것으로 취급하지 않는다.

Desktop의 Electron preset은 동일 rule이 실제로 유지되는지 비교한 뒤 유지하거나 공통 flat config로 옮긴다. Web·UI의 기본 lint는 ESLint로 통일하되, 기존 Oxlint의 명시 rule과 기본 검사 중 ESLint에 대응하지 않는 것은 보조 command와 CI에서 유지한다. 새 공통 설정이 같은 결과를 보장한다고 선언하지 않으며, 검증 없이 Oxlint dependency·rule·plugin을 삭제하지 않는다.

공통 ignore는 `node_modules`, 각 build output, OCR asset, generated/vendor artifact, lockfile, license와 고정 provenance 산출물을 책임에 맞게 제외한다. 이름에 `build`가 들어간다는 이유만으로 `packages/ui/build/notices.ts` 같은 직접 관리 generator source를 제외하지 않는다. SEED 원본과 provenance, OCR source, license/notice는 소유 source와 산출물을 구분해 처리한다.

구현은 승인된 config·dependency·glob·ignore와 기준 revision을 확인한 뒤 non-fix baseline, 설정 loading, 대표 파일 범위, `lint:fix`와 `format`의 첫 diff, 재실행 수렴, non-fix lint·`format:check`, 기존 test/typecheck/build 순서로 검증한다. 기준 baseline의 실제 수치와 파일별 결과는 [Issue #164 preflight evidence](https://github.com/blahaj94/ldb/issues/164#issuecomment-5583753742)에 연결하고 영구 Rule에 복제하지 않는다. 새 ESLint 통과나 CI 통과로 해석하지 않으며, native formatter 대량 diff는 config와 별도 commit으로 분리해 동작 보존을 검토한다. 기존 lint/format 부채는 baseline과 새 ESLint 결과를 함께 확인하기 전까지 확정하지 않는다. #149 Desktop source와 format diff가 겹치면 소유권을 확인해 순차화한다.

CI는 root command 하나가 전체 범위를 커버해도 되며, root·scripts·API·Desktop·Web·UI의 비수정 ESLint와 `format:check`를 누락 없이 확인해야 한다. 각 app command를 CI에서 중복 실행할 의무는 없다. Web·UI에서 ESLint에 대응하지 않는 기존 Oxlint 검사는 보조 command와 CI에 보존한다. 범위 일치와 누락 0을 확인하고, 새 실패를 ignore·disable·기대값 약화로 감추지 않는다.

## 적용 순서

작업 packet은 기준 revision, 적용 app, 설정 file, version, glob, ignore, 사용할 command, formatter가 만들 수 있는 산출물과 validation 범위를 기록한다. 조사 시점의 설정과 version은 permanent Rule에 복제하지 않고 [Issue #160의 조사 evidence](https://github.com/blahaj94/ldb/issues/160#issuecomment-5582657684)와 source path로 연결한다. 도입 전 API·Desktop의 ESLint, Desktop의 Prettier, Web·UI의 Oxlint와 root·scripts의 설정 공백은 조사 시점의 evidence이며, 공통 설정의 실제 완료 여부는 구현 결과에서 확인한다.

허용된 순서는 다음과 같다.

1. 승인된 config, version, glob, ignore와 대상 revision을 확인한다.
2. 설정에 이미 허용되고 fixer 결과가 검증된 ESLint 또는 Oxlint 자동수정을 실행한다.
3. 승인된 범위에서 Prettier를 실행하고, 충돌하면 Prettier 출력을 기준으로 맞춘다.
4. formatter를 다시 설계하지 않고 비수정 lint와 Prettier check를 실행한다.
5. 필요한 기존 test, typecheck, build 또는 app validation을 같은 입력과 범위로 실행한다.

최초 설정이나 충돌 조정에서는 같은 입력을 한 번 더 확인해 결과가 수렴하는지 확인한다. 매 실행마다 반복하거나 formatter 출력 일부를 수동으로 되돌리는 절차는 만들지 않는다. 검사 실패를 disable하거나 ignore에 추가해 통과시키지 않는다.

생성물·vendor·lockfile은 직접 `--write`하거나 수정하지 않는다. 생성 source나 template의 소유 규칙을 따르고, broad `--write .`로 승인되지 않은 범위를 포함하지 않는다. 도구가 처리할 수 없는 설정 공백은 계획 필요로 남긴다.

## 검토와 완료 기준

각 변경은 `도구가 결정한 표기`, `사람이 확인한 의미`, `validation evidence`를 구분해 기록한다. formatter가 바꾼 code를 사람이 기존 convention 모양으로 복원하지 않았는지, 문자열·함수 경계·객체 인자·평가와 오류 보존이 남아 있는지 확인한다.

도구 적용 PR의 Reviewer는 다음을 확인한다.

- 실제 config·version·glob·ignore와 command가 packet 및 diff 범위와 일치하는가?
- fixer와 Prettier가 설정된 책임만 수행했으며 미설정 rule·plugin·dependency를 암묵적으로 추가하지 않았는가?
- Prettier 우선순위가 [`code-expression.md`의 §2 문자열 위치와 §5 method chain 배치](code-expression.md#2-여러-줄-문자열에-이름을-붙이고-독립적인-생성은-함수로-분리한다)와 충돌하지 않게 적용됐는가?
- 의미별 빈 줄, boolean 이름, 함수 책임, 입력 역할, 평가 시점·호출 횟수·오류·cleanup이 formatter 출력 때문에 약화되지 않았는가?
- 비수정 lint·Prettier check와 필요한 기존 validation이 같은 revision과 범위에서 통과했는가?

도구 적용이 끝났다는 표시는 대상 설정 범위에만 해당한다. 설정되지 않은 app·root·scripts와 의미 판단은 `판단 필요`로 남기며, 저장소 전체 convention 완료로 확대하지 않는다.

승인 전에는 기존 Rule이 적용되며, 승인 후에도 이 문서가 명시한 설정 범위와 도구 책임을 넘는 변경은 별도 approval과 testing을 따른다.
