import { SEARCH_ERRORS } from '../../src/preload/common/types/search'

export type SearchUiObservation = {
  captureId: string | null
  revision: number
  slots: Array<{
    state: string
    requestId: string | null
    observationRevision: number
    code: string | null
    retryAfterSeconds: number | null
    retryDisabled: boolean | null
    retryCount: number
    statusMatched: boolean
    pending: boolean
  }>
  candidateMask: number
  ocrMask: number
  regionMask: number
  sourceSelected: boolean
  startDisabled: boolean | null
  horizontalOverflow: boolean
  dark: boolean
}

// 이 함수의 self-contained JavaScript만 소유한 fixture renderer에서 실행한다.
async function readSearchUi(messages: Record<string, string>): Promise<SearchUiObservation> {
  let snapshot
  try {
    const result = await window.search.controlCharacterSearch({ action: 'read' })
    if (!result.ok) {
      throw new Error('Search fixture state read failed')
    }
    snapshot = result.snapshot
  } catch {
    throw new Error('Search fixture state read failed')
  }
  let candidateMask = 0
  let regionMask = 0
  const slots = snapshot.slots.map((slot) => {
    const region = document.querySelector(`[aria-label="슬롯 ${slot.slot + 1} 검색"]`)
    const hasRegion = region != null
    if (hasRegion) {
      regionMask |= 1 << slot.slot
    }
    const rows = region?.querySelectorAll('ol > li') ?? []
    const rowText = rows[0]?.textContent ?? ''
    const hasOneCandidate = rows.length === 1
    const hasExpectedFields = ['ALICE', 'synthetic-character', '카인', 'cain', '12345'].every(
      (field) => rowText.includes(field)
    )
    const isSuccess = slot.state === 'success'
    const hasCandidate = isSuccess && hasOneCandidate && hasExpectedFields
    if (hasCandidate) {
      candidateMask |= 1 << slot.slot
    }
    const buttons = Array.from(region?.querySelectorAll('button') ?? []).filter((button) => {
      const isRetry = button.textContent?.trim() === '다시 시도'
      return isRetry
    })
    const stateLabels: Record<string, string> = {
      idle: '인식 대기',
      pending: '검색 중',
      empty: '검색 결과가 없습니다.'
    }
    const code = slot.error?.code ?? null
    const hasCode = code != null
    const expectedStatus = hasCode ? messages[code] : stateLabels[slot.state]
    const statusText = region?.querySelector('[role="status"]')?.textContent?.trim()
    const hasExpectedStatus = expectedStatus != null && statusText === expectedStatus
    const statusMatched = hasRegion && (isSuccess ? hasCandidate : hasExpectedStatus)
    return {
      state: slot.state,
      requestId: slot.requestId,
      observationRevision: slot.observationRevision,
      code,
      retryAfterSeconds: slot.error?.retryAfterSeconds ?? null,
      retryDisabled: buttons[0]?.disabled ?? null,
      retryCount: buttons.length,
      statusMatched,
      pending: region?.getAttribute('aria-busy') === 'true'
    }
  })
  const lines = document.querySelector('pre')?.textContent?.split('\n') ?? []
  let ocrMask = 0
  for (let slot = 0; slot < 4; slot += 1) {
    const hasExpectedOcr = lines.includes(`Slot ${slot + 1}: ALICE`)
    if (hasExpectedOcr) {
      ocrMask |= 1 << slot
    }
  }
  const source = document.querySelector('select')
  const sourceSelected = source != null && source.value.length > 0
  const start = Array.from(document.querySelectorAll('button')).find((button) => {
    const isStart = button.textContent?.trim() === 'Start'
    return isStart
  })
  const contentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  const horizontalOverflow = contentWidth > window.innerWidth + 1
  return {
    captureId: snapshot.captureId,
    revision: snapshot.revision,
    slots,
    candidateMask,
    ocrMask,
    regionMask,
    sourceSelected,
    startDisabled: start?.disabled ?? null,
    horizontalOverflow,
    dark: window.matchMedia('(prefers-color-scheme: dark)').matches
  }
}

const messages = Object.fromEntries(
  Object.entries(SEARCH_ERRORS).map(([code, error]) => [code, error.message])
)
const serializedMessages = JSON.stringify(messages)
export const inspectSearch = `(${readSearchUi.toString()})(${serializedMessages})`
