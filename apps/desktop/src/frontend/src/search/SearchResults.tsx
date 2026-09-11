import { ActionButton, ContentStack, ExampleSection, SupportingText } from '@ldb/ui'
import { SEARCH_ERRORS, type SearchSlot } from '../../../preload/common/types/search'
import type { SearchView } from './capture-search'

function SlotResult({
  slot,
  retryPending,
  retry
}: {
  slot: SearchSlot
  retryPending: boolean
  retry: (slot: number) => void
}): React.JSX.Element {
  const isPending = slot.state === 'pending'
  const isSuccess = slot.state === 'success'
  const isEmpty = slot.state === 'empty'
  const error = slot.error
  const isFailure = slot.state === 'failure'
  const hasError = error != null
  const shouldShowError = isFailure && hasError
  let canRetry: boolean | undefined
  let isRateLimited: boolean | undefined
  let hasRetryAfter: boolean | undefined
  let hasPositiveRetryAfter: boolean | undefined

  if (shouldShowError) {
    canRetry = SEARCH_ERRORS[error.code].retryable
    isRateLimited = error.code === 'SEARCH_RATE_LIMITED'
    if (isRateLimited) {
      const retryAfterSeconds = error.retryAfterSeconds
      const hasRetryAfterValue = retryAfterSeconds != null
      hasRetryAfter = hasRetryAfterValue
      if (hasRetryAfterValue) {
        const positiveRetryAfterSeconds = error.retryAfterSeconds
        const hasPositiveRetryAfterValue = positiveRetryAfterSeconds != null
        hasPositiveRetryAfter = hasPositiveRetryAfterValue && positiveRetryAfterSeconds > 0
      }
    }
  }

  const isWaiting = shouldShowError && isRateLimited && hasRetryAfter && hasPositiveRetryAfter
  const isBusy = isPending || retryPending
  const isRetryDisabled = isWaiting || retryPending
  const hasNickname = slot.nickname != null
  const status = isPending ? '검색 중' : isEmpty ? '검색 결과가 없습니다.' : '인식 대기'

  return (
    <section aria-label={`슬롯 ${slot.slot + 1} 검색`} aria-busy={isBusy}>
      <ExampleSection title={`슬롯 ${slot.slot + 1}`}>
        <ContentStack>
          {hasNickname && <SupportingText>{slot.nickname}</SupportingText>}
          <div role="status">
            {shouldShowError ? (
              <SupportingText>{SEARCH_ERRORS[error.code].message}</SupportingText>
            ) : (
              !isSuccess && <SupportingText>{status}</SupportingText>
            )}
          </div>
          {isSuccess && (
            <ol>
              {slot.rows.map((row, index) => (
                <li key={`${index}:${row.characterId}`}>
                  <SupportingText>{row.characterName}</SupportingText>
                  <SupportingText>캐릭터 ID: {row.characterId}</SupportingText>
                  <SupportingText>
                    서버: {row.serverName ?? '이름 정보 없음'} ({row.serverId})
                  </SupportingText>
                  <SupportingText>명성: {row.fame ?? '정보 없음'}</SupportingText>
                </li>
              ))}
            </ol>
          )}
          {isWaiting && (
            <SupportingText>
              {error.retryAfterSeconds}초 제한 대기 후 다시 시도할 수 있습니다.
            </SupportingText>
          )}
          {canRetry && (
            <ActionButton
              type="button"
              disabled={isRetryDisabled}
              loading={retryPending}
              onClick={() => retry(slot.slot)}
            >
              다시 시도
            </ActionButton>
          )}
        </ContentStack>
      </ExampleSection>
    </section>
  )
}

export function SearchResults({
  view,
  retry
}: {
  view: SearchView
  retry: (slot: number) => void
}): React.JSX.Element {
  return (
    <ContentStack>
      {view.connectionFailed && (
        <SupportingText>검색 연결을 확인할 수 없습니다. 앱 화면을 다시 열어 주세요.</SupportingText>
      )}
      {view.slots.map((slot) => (
        <SlotResult
          key={slot.slot}
          slot={slot}
          retryPending={view.retryPending[slot.slot]}
          retry={retry}
        />
      ))}
    </ContentStack>
  )
}
