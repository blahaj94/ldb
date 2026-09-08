const SEVERITIES = new Set(["P0", "P1", "P2", "P3", "info"]);

export function validateReviewResult(result) {
  const errors = [];
  const isResultObject = result != null && typeof result === "object";
  if (!isResultObject) {
    return { valid: false, errors: ["result must be an object"] };
  }

  const isHeadShaString = typeof result.headSha === "string";
  const isHeadShaEmpty = isHeadShaString && result.headSha.length === 0;
  const isHeadShaInvalid = !isHeadShaString || isHeadShaEmpty;
  if (isHeadShaInvalid) {
    errors.push("headSha must be a non-empty string");
  }
  const isSummaryString = typeof result.summary === "string";
  if (!isSummaryString) {
    errors.push("summary must be a string");
  }
  const isFindingsArray = Array.isArray(result.findings);
  if (!isFindingsArray) {
    errors.push("findings must be an array");
  } else {
    result.findings.forEach((finding, index) => {
      const hasValidSeverity = SEVERITIES.has(finding?.severity);
      if (!hasValidSeverity) {
        errors.push(`findings[${index}].severity is invalid`);
      }
      const isConfidenceNumber = typeof finding?.confidence === "number";
      const isConfidenceBelowMinimum =
        isConfidenceNumber && finding.confidence < 0;
      const isConfidenceAboveMaximum =
        isConfidenceNumber && !isConfidenceBelowMinimum && finding.confidence > 1;
      const isConfidenceInvalid =
        !isConfidenceNumber ||
        isConfidenceBelowMinimum ||
        isConfidenceAboveMaximum;
      if (isConfidenceInvalid) {
        errors.push(`findings[${index}].confidence must be between 0 and 1`);
      }
      for (const field of ["path", "evidence", "impact", "suggestedAction"]) {
        const isFieldString = typeof finding?.[field] === "string";
        const isFieldEmpty = isFieldString && finding[field].length === 0;
        const isFieldInvalid = !isFieldString || isFieldEmpty;
        if (isFieldInvalid) {
          errors.push(`findings[${index}].${field} must be a non-empty string`);
        }
      }
      const isLineInteger = Number.isInteger(finding?.line);
      const isLineBelowMinimum = isLineInteger && finding.line < 1;
      const isLineInvalid = !isLineInteger || isLineBelowMinimum;
      if (isLineInvalid) {
        errors.push(`findings[${index}].line must be a positive integer`);
      }
    });
  }
  const isMissingContextArray = Array.isArray(result.missingContext);
  if (!isMissingContextArray) {
    errors.push("missingContext must be an array");
  }

  const isValid = errors.length === 0;
  return { valid: isValid, errors };
}
