import { useEffect, useRef } from 'react'
import { createPartyOcrWorker } from './ocr'
import { runSerialLoop } from './recognition'

const SUPPORTED_WIDTH = 1920
const SUPPORTED_HEIGHT = 1080

type Worker = Awaited<ReturnType<typeof createPartyOcrWorker>>

type CaptureSession = {
  controller: AbortController
  stream: MediaStream | null
  video: HTMLVideoElement | null
  worker: Worker | null
}

type Options = {
  isSelectedSourceRegistered: () => boolean
  intervalSecondsRef: React.RefObject<number>
  setStatus: (status: string) => void
  recognizePartyNicknames: (
    video: HTMLVideoElement,
    worker: Worker,
    signal: AbortSignal
  ) => Promise<void>
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
  const sessionRef = useRef<CaptureSession | null>(null)

  function stopCapture(nextStatus = 'Capture stopped.'): void {
    releaseSession(sessionRef.current)
    sessionRef.current = null
    resetRecognition()
    setStatus(nextStatus)
  }

  useEffect(() => {
    return () => {
      releaseSession(sessionRef.current)
      sessionRef.current = null
    }
  }, [])

  async function startCapture(): Promise<void> {
    if (!isSelectedSourceRegistered()) {
      setStatus('Wait until the selected window is registered.')
      return
    }

    stopCapture()
    const session: CaptureSession = {
      controller: new AbortController(),
      stream: null,
      video: null,
      worker: null
    }
    sessionRef.current = session
    const { signal } = session.controller
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          frameRate: { ideal: 1, max: 1 },
          height: { ideal: SUPPORTED_HEIGHT },
          width: { ideal: SUPPORTED_WIDTH }
        }
      })
      session.stream = stream
      signal.throwIfAborted()
      const track = stream.getVideoTracks()[0]
      if (!track) throw new Error('The selected window did not provide a video track.')

      track.addEventListener('ended', () => stopCapture('Capture ended.'), { once: true, signal })

      const video = document.createElement('video')
      session.video = video
      video.muted = true
      const metadataLoaded = new Promise<void>((resolve) => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true, signal })
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      video.srcObject = stream
      await video.play()
      await metadataLoaded
      signal.throwIfAborted()
      if (video.videoWidth !== SUPPORTED_WIDTH || video.videoHeight !== SUPPORTED_HEIGHT) {
        throw new Error(`Unsupported capture layout: ${video.videoWidth}×${video.videoHeight}.`)
      }

      const worker = await createPartyOcrWorker()
      session.worker = worker
      signal.throwIfAborted()

      void runSerialLoop({
        signal,
        getIntervalMs: () => intervalSecondsRef.current * 1000,
        runCycle: () => recognizePartyNicknames(video, worker, signal)
      }).catch((error: unknown) => {
        if (!signal.aborted) {
          stopCapture(error instanceof Error ? error.message : 'Party OCR failed.')
        }
      })
      setStatus(`Capture ready at ${video.videoWidth}×${video.videoHeight}.`)
    } catch (error) {
      if (signal.aborted) {
        // 취소 후 반환된 stream/worker도 이 session에서 정리한다.
        releaseSession(session)
      } else {
        stopCapture(error instanceof Error ? error.message : 'Could not start capture.')
      }
    }
  }

  return { startCapture, stopCapture }
}

function releaseSession(session: CaptureSession | null): void {
  if (!session) return
  const { controller, stream, video, worker } = session
  session.stream = null
  session.video = null
  session.worker = null
  controller.abort()
  stream?.getTracks().forEach((track) => track.stop())
  if (video) {
    video.pause()
    video.srcObject = null
  }
  void worker?.terminate()
}
