import { describe, expect, it } from 'vitest'
import { PARTY_MANA_COLOR, PARTY_SLOTS, isPartySlotPresent } from './party'

describe('파티 layout', () => {
  it('1920×1080 기준 고정 파티 slot 네 개를 정의한다', () => {
    expect(PARTY_SLOTS).toHaveLength(4)
    expect(PARTY_SLOTS[0].nickname).toEqual({ x: 42, y: 11, width: 105, height: 18 })
    expect(PARTY_SLOTS[3].nickname).toEqual({ x: 492, y: 11, width: 105, height: 18 })
  })

  it('충분한 MP 색상 pixel이 있을 때만 slot이 존재한다고 판단한다', () => {
    const matchingPixels = new Uint8ClampedArray(60 * 4)
    for (let index = 0; index < matchingPixels.length; index += 4) {
      matchingPixels[index] = PARTY_MANA_COLOR[0]
      matchingPixels[index + 1] = PARTY_MANA_COLOR[1]
      matchingPixels[index + 2] = PARTY_MANA_COLOR[2]
      matchingPixels[index + 3] = 255
    }

    const oneMatchingPixel = new Uint8ClampedArray(60 * 4)
    oneMatchingPixel[0] = PARTY_MANA_COLOR[0]
    oneMatchingPixel[1] = PARTY_MANA_COLOR[1]
    oneMatchingPixel[2] = PARTY_MANA_COLOR[2]
    oneMatchingPixel[3] = 255

    expect(isPartySlotPresent(matchingPixels)).toBe(true)
    expect(isPartySlotPresent(oneMatchingPixel)).toBe(false)
  })
})
