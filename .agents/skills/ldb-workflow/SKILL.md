---
name: ldb-workflow
description: LDB 저장소의 Issue 작업과 PR 리뷰에 필요한 규칙 및 실행 명령을 찾는다.
---

# LDB Workflow

현재 요청과 Issue contract를 기준으로 [작업별 읽기 안내](../../../docs/README.md#역할별-시작점)에서 필요한 본문을 선택한다. 이 스킬은 진입점이며 규칙과 실행 권한은 canonical 문서에서 확인한다.

작업 준비와 검증 명령이 필요할 때는 다음 위치를 사용한다.

- 새 Issue branch와 worktree: [`start-task`](../../../scripts/README.md#start-task). 확정된 실행 Issue로 저장소 root에서 실행한다. 기존 Worker 배정의 base와 branch는 [배정·통합 계약](../../../docs/rules/agent-execution.md)에 따르며 `start-task`로 새 main base를 만들지 않는다.
- 변경 범위별 검증: [`Native validation`](../../../scripts/README.md#native-validation). 명령의 범위와 실행 조건을 확인하고, 추가 workspace 명령은 [Repository Map](../../../docs/reference/repository-map.md)에서 찾는다.

이 명령들은 Issue/preflight나 승인을 대신하지 않는다. 승인·제품별 실행 조건과 사용자 merge 권한은 [`change-control.md`](../../../docs/rules/change-control.md)를 따른다.
