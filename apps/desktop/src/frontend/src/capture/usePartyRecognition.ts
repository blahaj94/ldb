import { useRef, useState } from 'react'
import type { Worker } from 'tesseract.js'
import { capturePartyNicknameCrops, PARTY_SLOTS } from './party'
import { normalizeNickname, type SlotStability, updateSlotStability } from './recognition'

export function usePartyRecognition(): {
  stableNicknames: (string | null)[]
  recognizePartyNicknames: (
    video: HTMLVideoElement,
    worker: Worker,
    signal: AbortSignal
  ) => Promise<void>
  resetRecognition: () => void
} {
  const slotStabilityRef = useRef<(SlotStability | null)[]>(emptyStabilitySlots())
  const reportedNicknamesRef = useRef<(string | null)[]>(emptySlots())
  const stableNicknamesRef = useRef<(string | null)[]>(emptySlots())
  const [stableNicknames, setStableNicknames] = useState<(string | null)[]>(emptySlots())

  function resetRecognition(): void {
    slotStabilityRef.current = emptyStabilitySlots()
    reportedNicknamesRef.current = emptySlots()
    stableNicknamesRef.current = emptySlots()
    setStableNicknames(emptySlots())
  }

  async function recognizePartyNicknames(
    video: HTMLVideoElement,
    worker: Worker,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) return
    const crops = capturePartyNicknameCrops(video)
    const nextStableNicknames = stableNicknamesRef.current.slice()
    for (const [slot, crop] of crops.entries()) {
      const nickname = crop ? normalizeNickname((await worker.recognize(crop)).data.text) : null
      if (signal.aborted) return
      const stability = updateSlotStability(slotStabilityRef.current[slot], nickname || null)
      slotStabilityRef.current[slot] = stability
      if (!stability.stableNickname) {
        reportedNicknamesRef.current[slot] = null
        nextStableNicknames[slot] = null
        continue
      }
      nextStableNicknames[slot] = stability.stableNickname
      if (reportedNicknamesRef.current[slot] !== stability.stableNickname) {
        void window.api
          .notifyStableNicknameDetected({ nickname: stability.stableNickname, slot })
          .catch(() => undefined)
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

  return { stableNicknames, recognizePartyNicknames, resetRecognition }
}

function emptySlots(): (string | null)[] {
  return Array.from({ length: PARTY_SLOTS.length }, () => null)
}

function emptyStabilitySlots(): (SlotStability | null)[] {
  return Array.from({ length: PARTY_SLOTS.length }, () => null)
}
