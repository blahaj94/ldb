import { useLayoutEffect, useRef, useState } from 'react'
import { useCaptureSourceSelection } from './useCaptureSourceSelection'
import { usePartyCaptureSession } from './usePartyCaptureSession'
import { usePartyRecognition } from './usePartyRecognition'
import { useCharacterSearch } from '../search/useCharacterSearch'
import type { SearchView } from '../search/capture-search'

type PartyCapture = {
  search: SearchView
  retrySearch: (slot: number) => void
  starting: boolean
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
  const stopRef = useRef<() => void>(() => {})
  const search = useCharacterSearch(() => stopRef.current())
  const recognition = usePartyRecognition(search.observe)
  const captureSession = usePartyCaptureSession({
    isSelectedSourceRegistered,
    beginSearch: search.begin,
    endSearch: search.end,
    intervalSecondsRef,
    setStatus,
    recognizePartyNicknames: recognition.recognizePartyNicknames,
    resetRecognition: recognition.resetRecognition
  })

  useLayoutEffect(() => {
    stopRef.current = captureSession.stopCapture
  }, [captureSession.stopCapture])

  function selectSource(sourceId: string): void {
    captureSession.stopCapture()
    sourceSelection.selectSource(sourceId)
  }

  function setIntervalSeconds(seconds: number): void {
    intervalSecondsRef.current = seconds
    setIntervalSecondsState(seconds)
  }

  return {
    ...sourceSelection,
    selectSource,
    search,
    retrySearch: search.retry,
    intervalSeconds,
    stableNicknames: recognition.stableNicknames,
    status,
    setIntervalSeconds,
    ...captureSession
  }
}
