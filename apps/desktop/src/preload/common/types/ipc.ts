import type { CaptureSource, StableNicknameDetection } from './capture'

interface AsyncIPCFunctions {
  listCaptureSources: () => Promise<CaptureSource[]>
  selectCaptureSource: (sourceId: string) => Promise<CaptureSource | null>
  notifyStableNicknameDetected: (detection: StableNicknameDetection) => Promise<void>

  // Used inside tests, so we can be a bit lenient with the type checking here
  message: (...params: unknown[]) => void
}

export type { AsyncIPCFunctions }
