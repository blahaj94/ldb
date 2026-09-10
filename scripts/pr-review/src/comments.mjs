export const POLICY_MARKER = '<!-- ldb-ai-review-policy -->'

const STATUS_ICON = {
  pass: '✅',
  warning: '⚠️',
  skipped: '➖'
}

function cell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

export function providerMarker(provider, headSha) {
  return `<!-- ldb-ai-review:${provider}:${headSha} -->`
}

export function buildProviderTriggerComment({ provider, headSha }) {
  const isUnsupportedProvider = provider !== 'codex'
  if (isUnsupportedProvider) {
    throw new Error(`Unsupported review provider: ${provider}`)
  }

  const triggerCommentBody = [
    providerMarker(provider, headSha),
    '@codex review 리뷰 제목과 본문은 한국어 존댓말로 작성해 주세요.',
    '',
    `_Automated advisory review request for \`${headSha}\`._`
  ].join('\n')
  return triggerCommentBody
}

export function findCommentByMarker(comments, marker) {
  const matchingComment = comments.find((comment) => {
    const hasMarker = comment.body?.includes(marker)
    return hasMarker
  })
  return matchingComment
}

export function buildPolicySummary({ headSha, checks }) {
  const rows = checks.map(
    ({ name, status, detail }) =>
      `| ${cell(name)} | ${STATUS_ICON[status] ?? '❔'} ${cell(status)} | ${cell(detail)} |`
  )

  const policySummaryBody = [
    POLICY_MARKER,
    '## AI review policy check — Advisory',
    '',
    `Head: \`${headSha}\``,
    '',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'Warnings do not block merge. The repository owner makes the final decision.'
  ].join('\n')
  return policySummaryBody
}
