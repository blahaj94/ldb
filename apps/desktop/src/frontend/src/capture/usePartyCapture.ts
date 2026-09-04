import { useRef, useState } from 'react'
import { useCaptureSourceSelection } from './useCaptureSourceSelection'
import { usePartyCaptureSession } from './usePartyCaptureSession'
import { usePartyRecognition } from './usePartyRecognition'

type PartyCapture = {
  sources: { id: string; name: string }[]
  selectedSourceId: string
  sourceRegistered: boolean
  intervalSeconds: number
  stableNicknames: (string | null)[]
  status: string
  selectSource: (sourceId: string) => void
  setIntervalSeconds: (seconds: number) => void
  startCapture: () => Promise<void>
  stopCapture: (nextStatus?: string) => void
}

export function usePartyCapture(): PartyCapture {
  const intervalSecondsRef = useRef(3)
  const [intervalSeconds, setIntervalSecondsState] = useState(3)
  const [status, setStatus] = useState('Select a game window.')
  const { isSelectedSourceRegistered, ...sourceSelection } = useCaptureSourceSelection(setStatus)
  const recognition = usePartyRecognition()
  const captureSession = usePartyCaptureSession({
    isSelectedSourceRegistered,
    intervalSecondsRef,
    setStatus,
    recognizePartyNicknames: recognition.recognizePartyNicknames,
    resetRecognition: recognition.resetRecognition
  })

  function setIntervalSeconds(seconds: number): void {
    intervalSecondsRef.current = seconds
    setIntervalSecondsState(seconds)
  }

  return {
    ...sourceSelection,
    intervalSeconds,
    stableNicknames: recognition.stableNicknames,
    status,
    setIntervalSeconds,
    ...captureSession
  }
}
