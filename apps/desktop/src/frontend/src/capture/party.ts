export type Rectangle = {
  x: number
  y: number
  width: number
  height: number
}

type PartySlot = {
  nickname: Rectangle
  mana: Rectangle
}

export const PARTY_MANA_COLOR = [55, 121, 170] as const

// 1920×1080 borderless-window MVP layout. Add calibrated layouts only when their support is approved.
export const PARTY_SLOTS: readonly PartySlot[] = [
  {
    nickname: { x: 42, y: 11, width: 105, height: 18 },
    mana: { x: 42, y: 36, width: 105, height: 5 }
  },
  {
    nickname: { x: 192, y: 11, width: 105, height: 18 },
    mana: { x: 192, y: 36, width: 105, height: 5 }
  },
  {
    nickname: { x: 342, y: 11, width: 105, height: 18 },
    mana: { x: 342, y: 36, width: 105, height: 5 }
  },
  {
    nickname: { x: 492, y: 11, width: 105, height: 18 },
    mana: { x: 492, y: 36, width: 105, height: 5 }
  }
]

const MANA_COLOR_TOLERANCE = 35
const MINIMUM_MANA_PIXELS = 50
const OCR_SCALE = 4

export function isPartySlotPresent(rgba: Uint8ClampedArray): boolean {
  let matches = 0

  for (let index = 0; index < rgba.length; index += 4) {
    const hasMatchingRed = Math.abs(rgba[index] - PARTY_MANA_COLOR[0]) <= MANA_COLOR_TOLERANCE
    const hasMatchingGreen =
      hasMatchingRed && Math.abs(rgba[index + 1] - PARTY_MANA_COLOR[1]) <= MANA_COLOR_TOLERANCE
    const hasMatchingBlue =
      hasMatchingGreen && Math.abs(rgba[index + 2] - PARTY_MANA_COLOR[2]) <= MANA_COLOR_TOLERANCE
    const hasManaColor = hasMatchingRed && hasMatchingGreen && hasMatchingBlue
    if (hasManaColor) {
      matches += 1
      const hasMinimumManaPixels = matches >= MINIMUM_MANA_PIXELS
      if (hasMinimumManaPixels) {
        return true
      }
    }
  }

  return false
}

export function capturePartyNicknameCrops(video: HTMLVideoElement): (HTMLCanvasElement | null)[] {
  const frame = document.createElement('canvas')
  frame.width = video.videoWidth
  frame.height = video.videoHeight
  const frameContext = frame.getContext('2d')
  const hasFrameContext = frameContext != null
  if (!hasFrameContext) {
    throw new Error('Could not create a party capture canvas.')
  }

  frameContext.drawImage(video, 0, 0)

  return PARTY_SLOTS.map((slot) => {
    const mana = frameContext.getImageData(
      slot.mana.x,
      slot.mana.y,
      slot.mana.width,
      slot.mana.height
    )
    const isSlotPresent = isPartySlotPresent(mana.data)
    if (!isSlotPresent) {
      return null
    }

    const crop = document.createElement('canvas')
    crop.width = slot.nickname.width * OCR_SCALE
    crop.height = slot.nickname.height * OCR_SCALE
    const cropContext = crop.getContext('2d')
    const hasCropContext = cropContext != null
    if (!hasCropContext) {
      throw new Error('Could not create a party nickname canvas.')
    }

    cropContext.imageSmoothingEnabled = false
    cropContext.drawImage(
      frame,
      slot.nickname.x,
      slot.nickname.y,
      slot.nickname.width,
      slot.nickname.height,
      0,
      0,
      crop.width,
      crop.height
    )
    return crop
  })
}
