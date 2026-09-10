---
type: rule
status: active
enforcement: approval-required
scope: repository
---

# 텍스트 작성과 판단 책임

[이전 규칙의 승인 이력](https://github.com/blahaj94/ldb/pull/273#pullrequestreview-5161433802)은 당시 결정의 근거로 보존합니다. [Issue #295](https://github.com/blahaj94/ldb/issues/295)의 사용자 요청에 따라 텍스트 작성의 고정 모델 지정을 제거합니다. 변경 규칙은 해당 PR의 사용자 merge 후 이 문서를 포함한 checkout에서 적용합니다.

```yaml
status: active
enforcement: approval-required
rationale: 특정 외부 모델 호출을 강제하지 않고 텍스트 작성의 판단 책임과 사용자 선택을 유지합니다.
evidence: https://github.com/blahaj94/ldb/issues/295
exceptions: 사용자가 명시한 모델과 effort가 우선합니다.
review-after: 서로 다른 GitHub 글 3건에서 사실 보존과 문체 및 재작업 여부를 확인합니다.
```

- Issue, PR, 댓글의 텍스트 작성 및 다듬기에는 특정 모델이나 reasoning effort를 고정하지 않습니다. 사용자의 명시적 선택을 우선하고, 별도 선택이 없으면 현재 실행 환경에서 작성합니다.
- Planner는 작업 범위, 완료 조건, 설계 결정 및 게시 전 사실 일치 검토 책임을 유지하고, 작성자는 확정된 사실과 결정만을 글로 정리하며 빠진 결정이나 모호한 조건은 Planner에게 돌려보냅니다.
- [writing.md](writing.md)의 작성 기준을 따릅니다. 코드 작성과 code review의 모델 선택 기준은 유지합니다.
- 일반 텍스트 작성에 별도 모델 호출이나 모델 및 effort의 사전 확인을 요구하지 않습니다. 사용자가 명시한 설정을 사용할 수 없거나 확인하지 못하면 그 제약을 알리며, 확인하지 못한 설정을 적용했다고 보고하지 않습니다.
- 사용자가 현재 작업의 모델과 effort를 명시하면 그 선택을 즉시 우선합니다. 영구 Rule 변경은 [change-control.md](change-control.md)의 review 가능한 PR에서 채택 범위로 명시하며 사용자의 merge로 승인·활성화합니다.
