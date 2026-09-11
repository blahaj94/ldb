import { useRef, useState } from 'react'
import type { Worker } from 'tesseract.js'
import { capturePartyNicknameCrops, PARTY_SLOTS } from './party'
import { normalizeNickname, type SlotStability, updateSlotStability } from './recognition'

export function usePartyRecognition(
  observe: (input: { slot: number; nickname: string | null }) => void
): {
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
    if (signal.aborted) {
      return
    }
    const crops = capturePartyNicknameCrops(video)
    const nextStableNicknames = stableNicknamesRef.current.slice()
    for (const [slot, crop] of crops.entries()) {
      const hasCrop = crop != null
      const nickname = hasCrop ? normalizeNickname((await worker.recognize(crop)).data.text) : null
      if (signal.aborted) {
        return
      }
      const hasNickname = nickname != null
      let recognizedNickname: string | null = null
      if (hasNickname) {
        const isNicknameEmpty = nickname.length === 0
        if (!isNicknameEmpty) {
          recognizedNickname = nickname
        }
      }
      const stability = updateSlotStability(slotStabilityRef.current[slot], recognizedNickname)
      slotStabilityRef.current[slot] = stability
      const hasStableNickname = stability.stableNickname != null
      if (!hasStableNickname) {
        const hadReportedNickname = reportedNicknamesRef.current[slot] != null
        if (hadReportedNickname) {
          observe({ slot, nickname: null })
        }
        reportedNicknamesRef.current[slot] = null
        nextStableNicknames[slot] = null
        continue
      }
      nextStableNicknames[slot] = stability.stableNickname
      const isNewStableNickname = reportedNicknamesRef.current[slot] !== stability.stableNickname
      if (isNewStableNickname) {
        observe({ nickname: stability.stableNickname, slot })
        reportedNicknamesRef.current[slot] = stability.stableNickname
      }
    }
    const hasChangedNicknames = nextStableNicknames.some((nickname, slot) => {
      const hasChanged = nickname !== stableNicknamesRef.current[slot]
      return hasChanged
    })
    if (hasChangedNicknames) {
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
