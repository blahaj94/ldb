const SEVERITIES = new Set(["P0", "P1", "P2", "P3", "info"]);

export function validateReviewResult(result) {
  const errors = [];
  if (!result || typeof result !== "object") {
    return { valid: false, errors: ["result must be an object"] };
  }

  if (typeof result.headSha !== "string" || result.headSha.length === 0) {
    errors.push("headSha must be a non-empty string");
  }
  if (typeof result.summary !== "string") {
    errors.push("summary must be a string");
  }
  if (!Array.isArray(result.findings)) {
    errors.push("findings must be an array");
  } else {
    result.findings.forEach((finding, index) => {
      if (!SEVERITIES.has(finding?.severity)) {
        errors.push(`findings[${index}].severity is invalid`);
      }
      if (
        typeof finding?.confidence !== "number" ||
        finding.confidence < 0 ||
        finding.confidence > 1
      ) {
        errors.push(`findings[${index}].confidence must be between 0 and 1`);
      }
      for (const field of ["path", "evidence", "impact", "suggestedAction"]) {
        if (typeof finding?.[field] !== "string" || finding[field].length === 0) {
          errors.push(`findings[${index}].${field} must be a non-empty string`);
        }
      }
      if (!Number.isInteger(finding?.line) || finding.line < 1) {
        errors.push(`findings[${index}].line must be a positive integer`);
      }
    });
  }
  if (!Array.isArray(result.missingContext)) {
    errors.push("missingContext must be an array");
  }

  return { valid: errors.length === 0, errors };
}
