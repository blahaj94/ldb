import { useEffect, useRef } from 'react'
import { createPartyOcrWorker } from './ocr'
import { normalizeNickname, runSerialLoop } from './recognition'

const SUPPORTED_WIDTH = 1920
const SUPPORTED_HEIGHT = 1080

type Worker = Awaited<ReturnType<typeof createPartyOcrWorker>>

type Options = {
  isSelectedSourceRegistered: () => boolean
  intervalSecondsRef: React.RefObject<number>
  setStatus: (status: string) => void
  recognizePartyNicknames: (video: HTMLVideoElement, worker: Worker) => Promise<void>
  resetRecognition: () => void
}

export function usePartyCaptureSession({
  isSelectedSourceRegistered,
  intervalSecondsRef,
  setStatus,
  recognizePartyNicknames,
  resetRecognition
}: Options): {
  startCapture: () => Promise<void>
  stopCapture: (nextStatus?: string) => void
} {
  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const loopAbortRef = useRef<AbortController | null>(null)
  const captureGenerationRef = useRef(0)

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
    resetRecognition()
    setStatus(nextStatus)
  }

  useEffect(() => {
    return () => {
      captureGenerationRef.current += 1
      loopAbortRef.current?.abort()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      videoRef.current?.pause()
      videoRef.current = null
      void workerRef.current?.terminate()
    }
  }, [])

  async function startCapture(): Promise<void> {
    if (!isSelectedSourceRegistered()) {
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
          if (streamRef.current === stream) stopCapture('Capture ended.')
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

      const controller = new AbortController()
      loopAbortRef.current = controller
      void runSerialLoop({
        signal: controller.signal,
        getIntervalMs: () => intervalSecondsRef.current * 1000,
        runCycle: () => {
          const video = videoRef.current
          const worker = workerRef.current
          return video && worker ? recognizePartyNicknames(video, worker) : Promise.resolve()
        }
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) {
          stopCapture(error instanceof Error ? error.message : 'Party OCR failed.')
        }
      })
      setStatus(
        `Capture ready at ${video.videoWidth}×${video.videoHeight}; offline OCR: ${normalizeNickname(data.text)}.`
      )
    } catch (error) {
      if (captureGeneration !== captureGenerationRef.current) return
      stopCapture()
      setStatus(error instanceof Error ? error.message : 'Could not start capture.')
    }
  }

  return { startCapture, stopCapture }
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
