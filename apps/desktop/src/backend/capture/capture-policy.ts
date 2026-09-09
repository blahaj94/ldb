type SourceWithId = {
  id: string
}

type CaptureRequest = {
  hasSelectedSource: boolean
  isMainFrame: boolean
  videoRequested: boolean
  audioRequested: boolean
  userGesture: boolean
}

export function findSelectedSource<T extends SourceWithId>(
  sources: readonly T[],
  sourceId: string
): T | null {
  return sources.find((source) => source.id === sourceId) ?? null
}

export function isCaptureRequestAllowed({
  hasSelectedSource,
  isMainFrame,
  videoRequested,
  audioRequested,
  userGesture
}: CaptureRequest): boolean {
  const isVideoOnlyRequest = videoRequested && !audioRequested
  const isCaptureAllowed = hasSelectedSource && isMainFrame && isVideoOnlyRequest && userGesture

  return isCaptureAllowed
}
