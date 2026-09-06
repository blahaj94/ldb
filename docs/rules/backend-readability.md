---
type: rule
status: deprecated
enforcement: warning
scope: backend server source and related tests
last-reviewed: 2026-09-06
superseded-by: ../../convention.md
---

# Backend Readability — 이전 경로

공통 가독성 기준의 canonical document는 root [`convention.md`](../../convention.md)다. 기존 path를 참조하는 Issue·PR·agent는 해당 문서를 읽는다.

[PR #66의 사용자 승인](https://github.com/blahaj94/ldb/pull/66#issuecomment-5557123897)으로 적용한 Backend의 처리 순서·상태/실패 결과·이름·표현 밀도·helper/type 근거·주석·동작 보존 원칙을 공통 문서에 보존했다. 의미별 boolean 검사·최종 합성과 오류 책임을 구체화하고 적용 범위를 모든 작성 코드로 넓혔다.

이 경로 이전과 확장은 `convention.md` 제안의 승인·active 전환과 함께 적용한다. 기존 architecture·domain·security 계약과 [`change-control.md`](change-control.md)·[`testing.md`](testing.md)의 절차는 유지한다. 같은 작성 제약을 이 파일에 중복 정의하지 않는다.
