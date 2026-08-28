import { buildProviderTriggerComment, providerMarker } from "../comments.mjs";

export const codexProvider = {
  id: "codex",
  marker(headSha) {
    return providerMarker(this.id, headSha);
  },
  triggerComment(headSha) {
    return buildProviderTriggerComment({ provider: this.id, headSha });
  },
};
