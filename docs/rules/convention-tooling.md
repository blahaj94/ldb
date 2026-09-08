---
type: rule
status: proposed
enforcement: approval-required
scope: repository handwritten source, tests, scripts and tooling
last-reviewed: 2026-09-08
rationale: 기계적으로 확인·정렬할 수 있는 convention 작업은 승인된 도구에 맡기고, 의미·책임·동작 보존은 사람의 판단으로 분리한다.
evidence: "https://github.com/blahaj94/ldb/issues/160#issuecomment-5582657684; https://github.com/blahaj94/ldb/pull/161#issuecomment-5582698349"
exceptions: 승인 전에는 기존 active Rule과 설정을 우선 적용한다. 이 문서는 새 formatter·lint 설정이나 실행 권한을 만들지 않는다.
review-after: 사용자 승인·merge 후 서로 다른 app 또는 tooling의 적용 PR 3개에서 출력 수렴, 재작업, 검토 부담을 확인한다.
---

# Convention 도구 적용 제안

이 문서는 기존 convention을 ESLint·Oxlint·Prettier로 보조하는 이행 기준을 제안한다. 도구가 충분히 판단할 수 있는 표기와 정적 검사는 native command로 처리하고, 의미·이름·처리 단계·함수 책임·평가와 오류 보존은 편집 담당과 Reviewer가 판단한다. 이 문서는 제품 code, 설정, dependency, CI를 변경하거나 새 도구 실행을 승인하지 않는다.

도구로 충분한 수정만을 위해 별도 AI 작성자나 조사자를 배정하지 않는다. 기존 편집 담당이 native CLI를 실행하되, 필요한 의미 판단·독립 review·기존 checkout 소유권·validation 책임은 생략하지 않는다.

## 승인 상태와 우선순위

이 문서는 `proposed`다. Draft PR에서 사용자가 명시적으로 `승인`하고 merge하기 전에는 기존 active Rule과 현재 app 설정이 우선한다. 승인 전에는 Prettier 출력 우선이나 fixer 적용 범위를 제품 code에 확장하지 않는다.

승인 후 formatter가 적용되는 범위에서는 사용자가 선택한 대로 Prettier 출력을 기준으로 맞춘다. 기존 수동 체인 줄바꿈이나 여러 줄 template의 여는 백틱 위치가 Prettier 출력과 다르면, formatter 결과를 사람이 되돌리거나 다시 설계하지 않는다. 다만 문자열 내부의 값·개행·공백, 생성 함수의 책임, 의미별 빈 줄과 조건 이름, 평가 시점은 도구 출력이 약화시키지 않는지 별도로 확인한다.

기존 승인된 두 예외는 [`convention-exceptions-proposal.md`](convention-exceptions-proposal.md)의 active 기준을 따른다. PR #161의 사용자 승인과 merge는 그 두 예외의 lifecycle만 확정하며, 이 문서의 proposed 도구 우선 기준을 승인한 evidence로 해석하지 않는다.

## 도구가 맡는 일

Prettier는 설정된 파일 범위의 순수한 layout을 정리한다. 줄바꿈, 들여쓰기, 따옴표, 세미콜론, trailing comma와 같은 formatter 출력이 대상이다. Prettier는 짧은 `if`에 중괄호를 추가하지 않고, 의미별 빈 줄·boolean 이름·함수 책임·객체 인자의 역할을 판단하지 않는다. `--write`는 승인된 설정과 glob 범위에서만 사용한다.

ESLint·Oxlint는 현재 설정된 rule과 검증된 fixer의 범위만 사용한다. ESLint의 `curly`처럼 실제 설정에 명시되고 대상 파일에서 fixer 결과가 검증된 rule은 허용된 자동수정으로 기록할 수 있다. 현재 설정에 없는 `curly`, naming rule, custom rule, 새 plugin은 이 문서만으로 도입하지 않는다. 기존 Oxlint를 이 요청만으로 ESLint로 교체하지 않으며, Oxlint를 ESLint나 Prettier의 임의 대체로 사용하지 않는다.

다음은 도구에 맡기지 않는다.

- 조건의 의미, boolean 극성, nullish와 falsey의 계약, 검사 결과의 합성
- 처리 단계와 의미별 빈 줄, helper·함수 경계와 책임, 함수 입력의 역할
- property read, getter, short-circuit, 외부 호출, 시간·lock·취소 확인의 평가 시점과 횟수
- 오류 종류·우선순위, cleanup·rollback, 반환값·객체 identity, 문자열 내부 값과 개행

이 판단이 필요한 변경은 [`convention.md`](../../convention.md)와 [`code-expression.md`](code-expression.md)의 기존 기준 및 변경 절차를 따른다.

## 적용 순서

작업 packet은 기준 revision, 적용 app, 설정 file, version, glob, ignore, 사용할 command, formatter가 만들 수 있는 산출물과 validation 범위를 기록한다. 조사 시점의 설정과 version은 permanent Rule에 복제하지 않고 [Issue #160의 조사 evidence](https://github.com/blahaj94/ldb/issues/160#issuecomment-5582657684)와 source path로 연결한다. 현재 API·Desktop의 ESLint, Desktop의 Prettier, Web·UI의 Oxlint와 root·scripts의 설정 공백을 모두 설정 완료로 표현하지 않는다.

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
