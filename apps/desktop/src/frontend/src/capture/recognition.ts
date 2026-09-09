export type Rgb = readonly [red: number, green: number, blue: number]

export type SlotStability = {
  candidate: string | null
  consecutiveCount: number
  stableNickname: string | null
}

type SerialLoopOptions = {
  signal: AbortSignal
  getIntervalMs: () => number
  runCycle: () => Promise<void>
}

export function hasColorMatch(pixels: Iterable<Rgb>, target: Rgb, tolerance: number): boolean {
  for (const pixel of pixels) {
    const hasMatchingRed = Math.abs(pixel[0] - target[0]) <= tolerance
    const hasMatchingGreen = hasMatchingRed && Math.abs(pixel[1] - target[1]) <= tolerance
    const hasMatchingBlue = hasMatchingGreen && Math.abs(pixel[2] - target[2]) <= tolerance
    const isColorMatch = hasMatchingRed && hasMatchingGreen && hasMatchingBlue
    if (isColorMatch) {
      return true
    }
  }

  return false
}

export function normalizeNickname(text: string): string {
  return text.replace(/[^\p{Script=Hangul}A-Za-z0-9]/gu, '')
}

export function updateSlotStability(
  previous: SlotStability | null,
  nickname: string | null
): SlotStability {
  const hasNickname = nickname != null
  const isNicknameEmpty = hasNickname && nickname.length === 0
  const isNicknameMissingOrEmpty = !hasNickname || isNicknameEmpty
  if (isNicknameMissingOrEmpty) {
    return { candidate: null, consecutiveCount: 0, stableNickname: null }
  }

  const hasPrevious = previous != null
  const hasSameCandidate = hasPrevious && previous.candidate === nickname
  if (hasSameCandidate) {
    const consecutiveCount = previous.consecutiveCount + 1
    const isStable = consecutiveCount >= 2
    return {
      candidate: nickname,
      consecutiveCount,
      stableNickname: isStable ? nickname : null
    }
  }

  return { candidate: nickname, consecutiveCount: 1, stableNickname: null }
}

export async function runSerialLoop({
  signal,
  getIntervalMs,
  runCycle
}: SerialLoopOptions): Promise<void> {
  while (!signal.aborted) {
    await runCycle()
    if (signal.aborted) {
      return
    }
    await wait(getIntervalMs(), signal)
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds)

    function finish(): void {
      clearTimeout(timeout)
      signal.removeEventListener('abort', finish)
      resolve()
    }

    signal.addEventListener('abort', finish, { once: true })
  })
}
