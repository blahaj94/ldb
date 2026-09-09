---
type: rule
status: proposed
enforcement: approval-required
scope: repository
rationale: 완료 가능한 목표를 Project에서 선택하고 실행 Issue로 구체화해 계획과 착수를 구분한다.
evidence: "https://github.com/blahaj94/ldb/issues/234"
exceptions: 기존 실행 Issue와 기록을 재사용하며 작은 직접 요청에 불필요한 Discussion이나 Project를 강제하지 않는다.
review-after: 목표별 Project 2개에서 작업 착수와 완료 판정의 누락 및 중복 기록을 확인한다.
---

# 목표별 계획과 작업 착수

이 문서와 연결 문구는 Issue #234의 Rule 변경 제안이다. Draft PR의 명시적인 `승인` 댓글 전에는 현재 작업 절차를 대체하거나 GitHub 이관의 실행 근거로 사용하지 않는다. 승인과 실행 허용은 [`change-control.md`](change-control.md#approval-evidence)를 따른다.

## 기록별 책임

| 기록 | 관리할 내용 |
| --- | --- |
| Discussion | 아이디어, 대안, 미결정 사항과 목표 범위를 정한 근거 |
| GitHub Project | 완료 가능한 목표 하나의 현재 범위, 완료 조건, 내부 작업과 전체 진행 상황 |
| Project 내부 작업 | 사용자가 선택할 중간 결과, 완료 조건, 선행 작업과 연결된 실행 Issue |
| Execution Issue | 구현과 검증이 가능한 단위의 현재 실행 계약, 승인, 담당과 검증 근거 |
| PR | 해당 Issue의 실제 변경, 완료 조건별 검증 결과와 사용자 merge |

Discussion과 Project는 계획과 진입점이다. Rule 승인과 실제 구현의 권한은 기존 canonical Rule을 따른다. 목표의 현재 계약은 Project README, 내부 작업의 현재 계약은 해당 항목 본문, 실행 계약은 Issue 본문에서 각각 관리한다. 결정이 바뀌면 영향받는 계약과 링크를 함께 갱신하고 이전 근거를 남긴다. 원문을 여러 위치에 복제하지 않는다.

## Project의 크기와 범위

- Project는 기간이나 파일 개수보다 독립적으로 완료를 판정할 수 있는 결과를 기준으로 만든다. 한 분기 목표도 가능하지만 기간이 끝났다는 사실만으로 완료하지 않는다.
- `LDB 전체 작업`처럼 끝이 없는 저장소 전체 목록은 기록 조회용으로 남긴다. 새 작업 선택의 기본 위치는 목표별 Project다.
- 이름과 포함 범위, 제외 범위, 관찰 가능한 완료 조건을 함께 정한다. `로그인 화면 만들기`는 화면 모양과 명시한 UI 상태를 완성하는 목표다. 실제 인증 요청, 상태 저장과 화면 이동은 `로그인 기능 구현`의 별도 범위다.
- 범위와 완료 조건이 미확정이면 Discussion에서 논의한다. 결정된 목표만 Project로 만들고 원래 Discussion을 연결한다. 한 Discussion에서 여러 목표가 나와도 각각 구분한다.
- README에는 목표, 포함 및 제외 범위, 완료 조건, 논의와 승인 근거, 내부 작업 안내, 선행 목표와 보류 사유를 둔다. 모든 Issue의 상세 계약을 복제하지 않는다.

## 내부 작업과 Issue 분해

내부 작업은 GitHub Project의 draft item 또는 기존 Issue 항목으로 표현한다. 작은 작업이 이미 Execution Issue이면 그대로 연결하고, 큰 중간 결과는 draft item에 필요한 하위 작업과 실행 Issue를 연결한다. Draft item에는 결과, 완료 조건, 범위와 선행 관계를 기록한다. GitHub가 draft item의 중첩을 자동 제공한다고 가정하지 않으며 더 깊은 분해는 본문의 명명된 하위 작업과 링크로 표현한다.

하나의 내부 작업에 여러 Issue와 PR이 연결될 수 있다. 파일마다 기계적으로 쪼개거나 카드 하나를 PR 하나로 고정하지 않는다. 구현, 검증, merge 후 다음 작업에 인계할 수 있는 일관된 결과로 나눈다. 분해한 Issue는 [`Execution Issue`](agent-workflow.md#execution-issue)의 필수 정보를 갖춘다.

기존 Issue가 같은 결과를 맡고 있으면 우선 재사용한다. 범위를 더 나눠야 하면 기존 계약과 진행 결과를 확인하고 담당 범위와 남은 작업을 갱신한 뒤 연결한다. 공용 선행 Issue는 소유권을 하나로 유지하고 필요한 작업에서 같은 Issue를 참조한다. 여러 Project에 연결돼도 실행을 중복하지 않는다.

## 사용자의 실행 지시에서 PR까지

1. 사용자가 Codex에서 지정한 Project와 내부 작업을 식별한다. 이름이 중복돼 식별할 수 없으면 해당 링크만 확인한다. Project 전체 실행 지시와 내부 작업 하나의 실행 지시를 구분한다.
2. 관련 Project의 현재 목표와 해당 작업, 연결된 Discussion의 결정 및 승인 근거만 읽는다. 전체 backlog와 대화 이력을 미리 읽지 않는다.
3. 기존 실행 Issue와 PR, 진행 중 담당, 선행 조건을 확인한다. 사용자 지시가 기존 보류 조건을 해제하는 범위와 별도 Rule 승인 여부를 구분한다.
4. 필요한 실행 Issue를 재사용하거나 분해해 만들고 원래 Project 및 작업을 연결한다. 선택한 작업 안에서 자율적으로 분해하되 새로운 목표나 완료 조건을 추가하지 않는다.
5. Issue의 현재 계약과 연결된 Rule을 읽고 기존 preflight, 승인, 담당 기록을 거쳐 Issue별 branch와 worktree에서 실행한다. 각 PR은 해당 실행 Issue에 연결한다.
6. 선행 Issue의 결과가 필요한 다음 Issue는 선행 PR의 사용자 merge와 인계 확인 후 시작한다. 독립 작업의 병렬 수행은 기존 충돌, 자원 격리와 수행 모드 규칙을 따른다.
7. merge와 검증 결과를 Issue에 남기고 내부 작업, Project의 완료 조건을 차례로 확인한다. AI는 PR을 merge하지 않는다.

카드 이동, 담당자 지정, Issue 생성이나 reopen은 실행 지시가 아니다. 사용자가 이미 허용한 범위의 후속 단계마다 재허락을 요구하지 않으며, 별도 승인이나 미해결 선행 조건이 있을 때만 해당 범위를 보류한다. 범위 확대가 필요하면 추가 결과와 영향을 설명하고 사용자 선택을 받는다. 영향 없는 범위는 계속 진행한다.

작은 버그 수정이나 명확한 직접 요청에는 계획용 Project와 Discussion을 의무적으로 만들지 않는다. 관련 목표가 있으면 연결하고, 없으면 기존 Issue 기반 절차를 따른다. `start-task` 명령은 확정된 실행 Issue로 branch와 worktree를 만드는 단계다. 그 명령의 `project` 인자는 `api`, `desktop`, `repo` 등의 workspace 범위이며 GitHub Project를 뜻하지 않는다.

## 완료와 보존

- 실행 Issue는 [`진행, 대기와 완료`](agent-execution.md#진행-대기와-완료)의 유형별 기준을 따른다. Closed나 PR 생성만으로 성공으로 판단하지 않는다.
- 내부 작업은 연결된 필수 실행 Issue의 결과와 그 작업 자체의 완료 조건을 모두 충족해야 `Done`으로 표시한다. 부분 성공이나 보류는 근거와 남은 일을 본문에 남긴다.
- Project는 모든 필수 작업과 목표 자체의 완료 조건이 충족되고 필요한 통합 검증을 확인한 뒤 README에 `Completed`와 조건별 evidence를 기록한다. 자식 Issue 개수나 닫힘만으로 완료하지 않는다.
- Project 완료 기록 후 GitHub의 Close project로 활성 목록에서 정리하고 내용과 재열기 가능성을 보존한다. 여기서 `Completed`는 목표 달성 기록이고 GitHub의 closed 여부와 구분한다. 취소로 닫는 경우 완료로 기록하지 않는다. [GitHub의 Project 종료 안내](https://docs.github.com/en/issues/planning-and-tracking-with-projects/managing-your-project/closing-and-deleting-your-projects)를 따른다.
- 삭제하지 않는다. 완료된 목표의 추가 범위는 새 목표로 분리하며, 기존 Project 재개가 필요하면 사용자에게 범위를 확인하고 이전 완료 근거와 구분한다.

## 기존 기록의 전환

남은 작업부터 적용한다. 완료된 Issue와 PR은 원문과 승인, 검증 이력을 보존하고 새 실행 Issue로 복제하지 않는다. 기존 상위 추적 Issue에는 새 Project나 Discussion의 위치와 남은 책임을 연결한다. 이관만으로 기존 목표를 완료 처리하거나 실행 보류를 해제하지 않는다.

기존 Design Issue의 논의는 Discussion으로 연결하되 승인 댓글과 PR의 원래 위치를 유지한다. 상위 추적 Issue는 새 목표 추적을 중복 유지하기 위한 필수 단계가 아니다. 기존 실행 Issue의 계약과 실행 이력은 그 Issue에 남긴다.

GitHub 본문 수정 전 원문을 보관하고 수정 직전에 다시 대조한다. 변경된 본문은 재검토하며, 반영 후 링크와 실행 조건, 원문 근거 보존을 재조회한다. 보드의 상태 변경으로 Issue를 자동 종료하거나 agent를 자동 실행하는 기능은 이 변경에 포함하지 않는다.
