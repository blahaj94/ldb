import { ActionButton } from '@ldb/ui'
import { SearchResults } from '../search/SearchResults'
import { usePartyCapture } from './usePartyCapture'

function PartyCapture(): React.JSX.Element {
  const {
    sources,
    selectedSourceId,
    sourceRegistered,
    starting,
    search,
    retrySearch,
    intervalSeconds,
    stableNicknames,
    status,
    selectSource,
    setIntervalSeconds,
    startCapture,
    stopCapture
  } = usePartyCapture()
  const isSourceRegistered = sourceRegistered
  const isSearchReady = search.ready
  const cannotStartCapture = !isSourceRegistered || starting || !isSearchReady
  const displayLines = [
    status,
    ...stableNicknames.map((nickname, slot) => {
      const hasNickname = nickname != null
      if (!hasNickname) {
        return null
      }

      const isNicknameEmpty = nickname.length === 0
      if (isNicknameEmpty) {
        return null
      }

      return `Slot ${slot + 1}: ${nickname}`
    })
  ]
  const statusText = displayLines
    .filter((line): line is string => {
      const hasLine = line != null
      if (!hasLine) {
        return false
      }

      const isLineEmpty = line.length === 0
      return !isLineEmpty
    })
    .join('\n')

  return (
    <main>
      <label>
        Game window
        <select value={selectedSourceId} onChange={(event) => selectSource(event.target.value)}>
          <option value="">Select a window</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        OCR interval
        <select
          value={intervalSeconds}
          onChange={(event) => setIntervalSeconds(Number(event.target.value))}
        >
          <option value={1}>1 second</option>
          <option value={3}>3 seconds</option>
          <option value={5}>5 seconds</option>
        </select>
      </label>
      <ActionButton
        disabled={cannotStartCapture}
        loading={starting}
        type="button"
        onClick={() => void startCapture()}
      >
        Start
      </ActionButton>
      <ActionButton type="button" onClick={() => stopCapture()}>
        Stop
      </ActionButton>
      <pre>{statusText}</pre>
      <SearchResults view={search} retry={retrySearch} />
    </main>
  )
}

export default PartyCapture
