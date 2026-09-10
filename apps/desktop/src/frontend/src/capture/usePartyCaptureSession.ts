import { useEffect, useRef, useState } from 'react'
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
  beginSearch: (signal: AbortSignal) => Promise<string | null>
  endSearch: () => void
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
  beginSearch,
  endSearch,
  intervalSecondsRef,
  setStatus,
  recognizePartyNicknames,
  resetRecognition
}: Options): {
  starting: boolean
  startCapture: () => Promise<void>
  stopCapture: (nextStatus?: string) => void
} {
  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)
  const sessionRef = useRef<CaptureSession | null>(null)

  function stopCapture(nextStatus = 'Capture stopped.'): void {
    releaseSession(sessionRef.current)
    sessionRef.current = null
    startingRef.current = false
    setStarting(false)
    endSearch()
    resetRecognition()
    setStatus(nextStatus)
  }

  useEffect(() => {
    return () => {
      releaseSession(sessionRef.current)
      sessionRef.current = null
      endSearch()
    }
  }, [endSearch])

  async function startCapture(): Promise<void> {
    if (startingRef.current) {
      return
    }
    const isSourceRegistered = isSelectedSourceRegistered()
    if (!isSourceRegistered) {
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
    startingRef.current = true
    setStarting(true)
    const { signal } = session.controller
    try {
      const captureId = await beginSearch(signal)
      signal.throwIfAborted()
      const hasCapture = captureId != null
      if (!hasCapture) {
        throw new Error('검색을 시작하지 못했습니다. 창을 다시 선택해 주세요.')
      }
      startingRef.current = false
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
      const hasTrack = track != null
      if (!hasTrack) {
        throw new Error('The selected window did not provide a video track.')
      }

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
      const hasSupportedWidth = video.videoWidth === SUPPORTED_WIDTH
      const hasSupportedHeight = video.videoHeight === SUPPORTED_HEIGHT
      const hasSupportedLayout = hasSupportedWidth && hasSupportedHeight
      if (!hasSupportedLayout) {
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
        const isCaptureActive = !signal.aborted
        if (isCaptureActive) {
          const isError = error instanceof Error
          stopCapture(isError ? error.message : 'Party OCR failed.')
        }
      })
      startingRef.current = false
      setStarting(false)
      setStatus(`Capture ready at ${video.videoWidth}×${video.videoHeight}.`)
    } catch (error) {
      if (signal.aborted) {
        // 취소 후 반환된 stream/worker도 이 session에서 정리한다.
        releaseSession(session)
      } else {
        const isError = error instanceof Error
        stopCapture(isError ? error.message : 'Could not start capture.')
      }
    }
  }

  return { starting, startCapture, stopCapture }
}

function releaseSession(session: CaptureSession | null): void {
  const hasSession = session != null
  if (!hasSession) {
    return
  }
  const { controller, stream, video, worker } = session
  session.stream = null
  session.video = null
  session.worker = null
  controller.abort()
  stream?.getTracks().forEach((track) => track.stop())
  const hasVideo = video != null
  if (hasVideo) {
    video.pause()
    video.srcObject = null
  }
  void worker?.terminate()
}
