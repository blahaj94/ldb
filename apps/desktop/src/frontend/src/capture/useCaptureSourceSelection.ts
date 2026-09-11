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
          const isError = error instanceof Error
          setStatus(isError ? error.message : 'Could not list windows.')
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
        const hasSourceId = sourceId.length > 0
        if (!hasSourceId) {
          return
        }
        const hasCurrentGeneration = selectionGeneration === selectionGenerationRef.current
        if (!hasCurrentGeneration) {
          return
        }

        const hasCurrentSelection = selectedSourceIdRef.current === sourceId
        if (hasCurrentSelection) {
          registeredSourceIdRef.current = sourceId
          setSourceRegistered(true)
        }
      })
      .catch((error: unknown) => {
        const hasCurrentGeneration = selectionGeneration === selectionGenerationRef.current
        if (hasCurrentGeneration) {
          const isError = error instanceof Error
          setStatus(isError ? error.message : 'Could not select the window.')
        }
      })
  }

  function isSelectedSourceRegistered(): boolean {
    const isRegistered = selectedSourceIdRef.current === registeredSourceIdRef.current

    return isRegistered
  }

  return {
    sources,
    selectedSourceId,
    sourceRegistered,
    isSelectedSourceRegistered,
    selectSource
  }
}
