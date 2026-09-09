---
name: 개발 작업
about: 사람이 읽는 작업 설명과 AI가 실행할 상세 정보를 작성합니다.
title: '[feat] '
---

<!--
AI 작성 지침: 게시 전에 안내를 실제 내용으로 바꾸고 모든 필수 정보를 확인합니다.
제목은 docs/rules/agent-workflow.md의 Issue 제목 기준에 따라 [type] 한국어 제목으로 씁니다.
type: feat, fix, refactor, docs, test, chore, design, research 중 주된 완료 결과 하나입니다.
본문 구성은 같은 문서의 '사람이 읽는 설명과 접힌 실행 정보'를 따릅니다.
현재 계약과 배정은 Issue 본문에서 갱신하고, 과거 근거는 정확한 댓글 링크로 연결합니다.
PR에는 Issue의 반복 대신 실제 변경과 완료 조건별 검증 결과를 기록합니다.
-->

## 작업 설명

<!--
문제와 필요한 이유 → 주요 변경 → 완료 후 달라지는 점을 보통 2~3문단으로 설명합니다.
그 작업을 모르는 사람도 변경 방향을 판단할 수 있도록 구체적인 대상과 변경을 씁니다.
제안과 확정된 결정, 계획과 확인한 결과를 구분합니다.
승인이나 선택이 필요하면 판단할 사항과 제안 이유를 여기에 씁니다.
중요한 제약, 구현 보류, 미완료와 미검증 조건을 접힌 영역에만 넣지 않습니다.
필요할 때만 '확인이 필요한 사항' 소제목을 추가합니다.
-->

<details>
<summary>AI 작업 상세</summary>

### 목표와 관찰 가능한 결과

<!-- 필수: 달성할 목표와 외부에서 관찰할 수 있는 결과를 작성합니다. -->

### 완료 조건

<!-- 필수: 구체적인 상황과 기대 결과를 짝지어 검증 가능한 체크리스트로 씁니다. -->

- [ ]

### 변경 범위와 제외 범위

<!-- 필수: 이번에 변경할 범위와 명시적으로 변경하지 않을 범위를 각각 씁니다. -->

### 원래 목표와 선택한 작업

<!--
Project에서 착수한 작업이면 Project URL, 내부 작업 링크, 관련 Discussion의 결정 근거와
사용자가 실행을 지시한 범위를 기록합니다. 기존 Issue를 재사용하고 중복 생성하지 않습니다.
직접 요청으로 시작한 작은 작업은 그 사실과 실행 범위를 씁니다.
대화 원문과 내부 task/turn ID는 게시하지 않습니다.
분해한 작업과 공용 선행 Issue는 링크로 연결합니다.
-->

### 관련 규칙과 근거

<!--
필수: docs/README.md의 역할별 시작점에서 필요한 파일 경로, symbol, 절을 연결합니다.
승인 댓글, 선행 PR, commit, 테스트 근거는 정확한 위치를 연결합니다.
규칙과 소스, 대화 전체를 복사하지 않습니다.
-->

### 작업 특성과 조사 필요 여부

<!-- 필수: provider나 model 이름 대신 작업 특성과 필요한 capability를 기록합니다. -->

```yaml
complexity: low | medium | high
uncertainty: low | medium | high
risk: low | medium | high
worker_model_tier: low | standard | high
scout: no | yes
scout_scope:
```

### 담당과 배정, 통합 상태

<!--
worker_count는 필수이며 1~8 중 현재 배정 계획의 Worker slot 수를 씁니다.
동시 process 수가 아니며 Scout, Reviewer, Runner와 누적 retry는 세지 않습니다.
배정 전 담당과 worker_count만큼의 Worker를 기록하고 상태와 head 변경 시 갱신합니다.
과거 배정은 댓글 이력에 남깁니다. agent-execution.md의 배정과 상태 기준을 따릅니다.
-->

```yaml
worker_count: 1
planner:
integration_owner:
integration_branch:
integration_head:
workers:
  - worker_id:
    scope:
    out_of_scope:
    dependencies:
    status: assigned | working | waiting | handed-off | integrated | stopped | failed
    branch:
    base:
    integration_order:
    result:
    validation:
    blocker:
```

### 선행 작업과 장애 요인

<!-- Blocked by #123, Blocks #456 형식과 병렬 충돌, 외부 dependency를 씁니다. 없으면 없다고 씁니다. -->

### 검증 방법

<!--
필수: 완료 전에 실행할 test, typecheck, lint, build 명령어와 수동 확인 근거를 씁니다.
PR에는 계획의 반복 대신 실제 실행 결과와 차이를 기록합니다.
-->

### 제약과 중단 조건

<!--
필수: 작업을 멈추고 Planner, 상위 검토자 또는 사람에게 판단을 요청할 조건을 씁니다.
이미 결정된 성능, 호환성, UI/UX, 보안 등의 제약이 있으면 함께 씁니다.
사람의 판단에 중요한 조건은 바깥 작업 설명에도 표시합니다.
-->

### 보안 확인

- [ ] 이 Issue에 secret, token, credential, 개인정보를 포함하지 않았습니다.

</details>
