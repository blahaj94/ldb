import { useEffect, useRef, useState } from 'react'

type CaptureSource = { id: string; name: string }

export function useCaptureSourceSelection(setStatus: (status: string) => void): {
  sources: CaptureSource[]
  selectedSourceId: string
  sourceRegistered: boolean
  isSelectedSourceRegistered: () => boolean
  selectSource: (sourceId: string) => void
} {
  const selectionGenerationRef = useRef(0)
  const selectedSourceIdRef = useRef('')
  const registeredSourceIdRef = useRef<string | null>(null)
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [sourceRegistered, setSourceRegistered] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api
      .listCaptureSources()
      .then((nextSources) => {
        if (!cancelled) {
          setSources(nextSources)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : 'Could not list windows.')
        }
      })
    return () => {
      cancelled = true
      selectionGenerationRef.current += 1
      void window.api.selectCaptureSource('').catch(() => undefined)
    }
  }, [setStatus])

  function selectSource(sourceId: string): void {
    const selectionGeneration = ++selectionGenerationRef.current
    selectedSourceIdRef.current = sourceId
    registeredSourceIdRef.current = null
    setSelectedSourceId(sourceId)
    setSourceRegistered(false)
    void window.api
      .selectCaptureSource(sourceId)
      .then(() => {
        if (
          sourceId &&
          selectionGeneration === selectionGenerationRef.current &&
          selectedSourceIdRef.current === sourceId
        ) {
          registeredSourceIdRef.current = sourceId
          setSourceRegistered(true)
        }
      })
      .catch((error: unknown) => {
        if (selectionGeneration === selectionGenerationRef.current) {
          setStatus(error instanceof Error ? error.message : 'Could not select the window.')
        }
      })
  }

  function isSelectedSourceRegistered(): boolean {
    return selectedSourceIdRef.current === registeredSourceIdRef.current
  }

  return {
    sources,
    selectedSourceId,
    sourceRegistered,
    isSelectedSourceRegistered,
    selectSource
  }
}
