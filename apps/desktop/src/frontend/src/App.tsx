import { usePartyCapture } from './usePartyCapture'

function App(): React.JSX.Element {
  const {
    sources,
    selectedSourceId,
    sourceRegistered,
    intervalSeconds,
    stableNicknames,
    status,
    selectSource,
    setIntervalSeconds,
    startCapture,
    stopCapture
  } = usePartyCapture()

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
      <button disabled={!sourceRegistered} type="button" onClick={() => void startCapture()}>
        Start
      </button>
      <button type="button" onClick={() => stopCapture()}>
        Stop
      </button>
      <pre>
        {[
          status,
          ...stableNicknames.map((nickname, slot) => nickname && `Slot ${slot + 1}: ${nickname}`)
        ]
          .filter(Boolean)
          .join('\n')}
      </pre>
    </main>
  )
}

export default App
