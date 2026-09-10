---
type: rule
status: active
enforcement: approval-required
scope: repository
---

# 텍스트 작성 모델

[PR #273의 사용자 승인](https://github.com/blahaj94/ldb/pull/273#pullrequestreview-5161433802)을 반영합니다. 저장소 기본 규칙은 사용자 merge 후 이 문서를 포함한 checkout에서 적용합니다.

```yaml
status: active
enforcement: approval-required
rationale: 텍스트 작성의 모델과 판단 책임을 일관되게 관리합니다.
evidence: https://github.com/blahaj94/ldb/pull/273#pullrequestreview-5161433802
exceptions: 사용자가 명시한 모델과 effort가 우선합니다.
review-after: 서로 다른 GitHub 글 3건에서 사실 보존과 문체 및 재작업 여부를 확인합니다.
```

- Issue, PR, 댓글의 텍스트 작성 및 다듬기는 `google-antigravity/gemini-3.7-flash`, reasoning effort `low`를 기본으로 지정합니다.
- Planner는 작업 범위, 완료 조건, 설계 결정 및 게시 전 사실 일치 검토 책임을 유지하고, 작성자는 확정된 사실과 결정만을 글로 정리하며 빠진 결정이나 모호한 조건은 Planner에게 돌려보냅니다.
- [writing.md](writing.md)의 작성 기준을 따르며, 이 mapping은 코드 작성과 code review 모델을 변경하지 않습니다.
- 호출 전에 실제 모델과 effort 선택을 확인하고, 사용할 수 없거나 확인하지 못하면 사용자에게 알리며 다른 모델로 조용히 대체하거나 적용했다고 보고하지 않습니다.
- 사용자가 현재 작업의 모델과 effort를 명시하면 그 선택을 즉시 우선합니다. 영구 Rule 변경은 [change-control.md](change-control.md)의 review 가능한 PR에 반영하며 사용자의 merge로 승인·활성화합니다.
