import { useEffect, useRef, useState } from 'react'
import { createPartyOcrWorker } from './ocr'
import { capturePartyNicknameCrops, PARTY_SLOTS } from './party'
import {
  normalizeNickname,
  runSerialLoop,
  type SlotStability,
  updateSlotStability
} from './recognition'

const SUPPORTED_WIDTH = 1920
const SUPPORTED_HEIGHT = 1080

function App(): React.JSX.Element {
  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const workerRef = useRef<Awaited<ReturnType<typeof createPartyOcrWorker>> | null>(null)
  const loopAbortRef = useRef<AbortController | null>(null)
  const captureGenerationRef = useRef(0)
  const sourceSelectionGenerationRef = useRef(0)
  const selectedSourceIdRef = useRef('')
  const registeredSourceIdRef = useRef<string | null>(null)
  const intervalSecondsRef = useRef(3)
  const slotStabilityRef = useRef<(SlotStability | null)[]>(emptyStabilitySlots())
  const reportedNicknamesRef = useRef<(string | null)[]>(emptySlots())
  const stableNicknamesRef = useRef<(string | null)[]>(emptySlots())
  const [sources, setSources] = useState<{ id: string; name: string }[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [sourceRegistered, setSourceRegistered] = useState(false)
  const [intervalSeconds, setIntervalSeconds] = useState(3)
  const [stableNicknames, setStableNicknames] = useState<(string | null)[]>(emptySlots())
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
      captureGenerationRef.current += 1
      sourceSelectionGenerationRef.current += 1
      loopAbortRef.current?.abort()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      videoRef.current?.pause()
      videoRef.current = null
      void workerRef.current?.terminate()
    }
  }, [])

  function stopCapture(nextStatus = 'Capture stopped.'): void {
    captureGenerationRef.current += 1
    loopAbortRef.current?.abort()
    loopAbortRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    videoRef.current?.pause()
    videoRef.current = null
    const worker = workerRef.current
    workerRef.current = null
    void worker?.terminate()
    slotStabilityRef.current = emptyStabilitySlots()
    reportedNicknamesRef.current = emptySlots()
    stableNicknamesRef.current = emptySlots()
    setStableNicknames(emptySlots())
    setStatus(nextStatus)
  }

  function handleSourceChange(sourceId: string): void {
    const selectionGeneration = ++sourceSelectionGenerationRef.current
    selectedSourceIdRef.current = sourceId
    registeredSourceIdRef.current = null
    setSelectedSourceId(sourceId)
    setSourceRegistered(false)

    void window.api
      .selectCaptureSource(sourceId)
      .then(() => {
        if (
          sourceId &&
          selectionGeneration === sourceSelectionGenerationRef.current &&
          selectedSourceIdRef.current === sourceId
        ) {
          registeredSourceIdRef.current = sourceId
          setSourceRegistered(true)
        }
      })
      .catch((error: unknown) => {
        if (selectionGeneration === sourceSelectionGenerationRef.current) {
          setStatus(error instanceof Error ? error.message : 'Could not select the window.')
        }
      })
  }

  async function startCapture(): Promise<void> {
    if (!sourceRegistered || registeredSourceIdRef.current !== selectedSourceIdRef.current) {
      setStatus('Wait until the selected window is registered.')
      return
    }

    stopCapture()
    const captureGeneration = ++captureGenerationRef.current

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          frameRate: { ideal: 1, max: 1 },
          height: { ideal: SUPPORTED_HEIGHT },
          width: { ideal: SUPPORTED_WIDTH }
        }
      })
      if (captureGeneration !== captureGenerationRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      const track = stream.getVideoTracks()[0]
      if (!track) throw new Error('The selected window did not provide a video track.')

      streamRef.current = stream
      track.addEventListener(
        'ended',
        () => {
          if (streamRef.current === stream) {
            stopCapture('Capture ended.')
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
      if (captureGeneration !== captureGenerationRef.current) return
      videoRef.current = video

      if (video.videoWidth !== SUPPORTED_WIDTH || video.videoHeight !== SUPPORTED_HEIGHT) {
        stopCapture()
        setStatus(`Unsupported capture layout: ${video.videoWidth}×${video.videoHeight}.`)
        return
      }

      const worker = await createPartyOcrWorker()
      if (captureGeneration !== captureGenerationRef.current || streamRef.current !== stream) {
        await worker.terminate()
        return
      }

      workerRef.current = worker
      const { data } = await worker.recognize(createOcrProbe())
      if (captureGeneration !== captureGenerationRef.current) return
      const probeResult = normalizeNickname(data.text)

      const controller = new AbortController()
      loopAbortRef.current = controller
      void runSerialLoop({
        signal: controller.signal,
        getIntervalMs: () => intervalSecondsRef.current * 1000,
        runCycle: () => recognizePartyNicknames()
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) {
          stopCapture(error instanceof Error ? error.message : 'Party OCR failed.')
        }
      })

      setStatus(
        `Capture ready at ${video.videoWidth}×${video.videoHeight}; offline OCR: ${probeResult}.`
      )
    } catch (error) {
      if (captureGeneration !== captureGenerationRef.current) return
      stopCapture()
      setStatus(error instanceof Error ? error.message : 'Could not start capture.')
    }
  }

  async function recognizePartyNicknames(): Promise<void> {
    const video = videoRef.current
    const worker = workerRef.current
    if (!video || !worker) return

    const crops = capturePartyNicknameCrops(video)
    const nextStableNicknames = stableNicknamesRef.current.slice()

    for (const [slot, crop] of crops.entries()) {
      const nickname = crop ? normalizeNickname((await worker.recognize(crop)).data.text) : null
      const stability = updateSlotStability(slotStabilityRef.current[slot], nickname || null)
      slotStabilityRef.current[slot] = stability

      if (!stability.stableNickname) {
        reportedNicknamesRef.current[slot] = null
        nextStableNicknames[slot] = null
        continue
      }

      nextStableNicknames[slot] = stability.stableNickname
      if (reportedNicknamesRef.current[slot] !== stability.stableNickname) {
        window.api.notifyStableNicknameDetected({ nickname: stability.stableNickname, slot })
        reportedNicknamesRef.current[slot] = stability.stableNickname
      }
    }

    if (
      nextStableNicknames.some((nickname, slot) => nickname !== stableNicknamesRef.current[slot])
    ) {
      stableNicknamesRef.current = nextStableNicknames
      setStableNicknames(nextStableNicknames)
    }
  }

  function handleIntervalChange(nextIntervalSeconds: number): void {
    intervalSecondsRef.current = nextIntervalSeconds
    setIntervalSeconds(nextIntervalSeconds)
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
          onChange={(event) => handleIntervalChange(Number(event.target.value))}
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

function emptySlots(): (string | null)[] {
  return Array.from({ length: PARTY_SLOTS.length }, () => null)
}

function emptyStabilitySlots(): (SlotStability | null)[] {
  return Array.from({ length: PARTY_SLOTS.length }, () => null)
}

function createOcrProbe(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 600
  canvas.height = 100
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not create an OCR probe canvas.')

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#000000'
  context.font = '48px Dotum'
  context.fillText('테스트ABC123', 16, 68)
  return canvas
}

export default App
