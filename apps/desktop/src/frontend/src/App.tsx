import { useEffect, useRef, useState } from 'react'

const SUPPORTED_WIDTH = 1920
const SUPPORTED_HEIGHT = 1080

function App(): React.JSX.Element {
  const streamRef = useRef<MediaStream | null>(null)
  const [sources, setSources] = useState<{ id: string; name: string }[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [sourceRegistered, setSourceRegistered] = useState(false)
  const [intervalSeconds, setIntervalSeconds] = useState(3)
  const [status, setStatus] = useState('Select a game window.')

  useEffect(() => {
    let cancelled = false

    void window.api
      .listCaptureSources()
      .then((nextSources) => {
        if (!cancelled) setSources(nextSources)
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setStatus(error instanceof Error ? error.message : 'Could not list windows.')
      })

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  function stopCapture(): void {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setStatus('Capture stopped.')
  }

  function handleSourceChange(sourceId: string): void {
    setSelectedSourceId(sourceId)
    setSourceRegistered(false)

    if (!sourceId) return

    void window.api
      .selectCaptureSource(sourceId)
      .then(() => setSourceRegistered(true))
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : 'Could not select the window.')
      })
  }

  async function startCapture(): Promise<void> {
    if (!sourceRegistered) {
      setStatus('Wait until the selected window is registered.')
      return
    }

    stopCapture()

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          frameRate: { ideal: 1, max: 1 },
          height: { ideal: SUPPORTED_HEIGHT },
          width: { ideal: SUPPORTED_WIDTH }
        }
      })
      const track = stream.getVideoTracks()[0]
      if (!track) throw new Error('The selected window did not provide a video track.')

      streamRef.current = stream
      track.addEventListener(
        'ended',
        () => {
          if (streamRef.current === stream) {
            streamRef.current = null
            setStatus('Capture ended.')
          }
        },
        { once: true }
      )

      const video = document.createElement('video')
      video.muted = true
      video.srcObject = stream
      const metadataLoaded = new Promise<void>((resolve) =>
        video.addEventListener('loadedmetadata', () => resolve(), { once: true })
      )
      await video.play()
      await metadataLoaded

      if (video.videoWidth !== SUPPORTED_WIDTH || video.videoHeight !== SUPPORTED_HEIGHT) {
        stopCapture()
        setStatus(`Unsupported capture layout: ${video.videoWidth}×${video.videoHeight}.`)
        return
      }

      setStatus(
        `Capture ready at ${video.videoWidth}×${video.videoHeight}; OCR interval: ${intervalSeconds}s.`
      )
    } catch (error) {
      stopCapture()
      setStatus(error instanceof Error ? error.message : 'Could not start capture.')
    }
  }

  return (
    <main>
      <label>
        Game window
        <select
          value={selectedSourceId}
          onChange={(event) => handleSourceChange(event.target.value)}
        >
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
      <button type="button" onClick={stopCapture}>
        Stop
      </button>
      <pre>{status}</pre>
    </main>
  )
}

export default App
