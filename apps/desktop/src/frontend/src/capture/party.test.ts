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

  it.each([
    { name: 'red mismatch', values: [0, 121, 170], reads: ['red'] },
    { name: 'green mismatch', values: [55, 0, 170], reads: ['red', 'green'] },
    { name: 'all match', values: [55, 121, 170], reads: ['red', 'green', 'blue'] }
  ])('$name reads only the required RGB channels', ({ values, reads }) => {
    const access: string[] = []
    const rgba = {
      length: 4,
      0: values[0],
      1: values[1],
      2: values[2],
      3: 255
    }
    for (const [index, channel] of [
      [0, 'red'],
      [1, 'green'],
      [2, 'blue']
    ] as const) {
      Object.defineProperty(rgba, index, {
        configurable: true,
        get: () => {
          access.push(channel)
          return values[index]
        }
      })
    }

    isPartySlotPresent(rgba as unknown as Uint8ClampedArray)

    expect(access).toEqual(reads)
  })

  it('reads all matching RGB channels for every pixel needed to reach the threshold', () => {
    const access: string[] = []
    const rgba = { length: 60 * 4 } as Record<number | 'length', number>
    for (let index = 0; index < rgba.length; index += 4) {
      for (const [offset, channel] of [
        [0, 'red'],
        [1, 'green'],
        [2, 'blue']
      ] as const) {
        Object.defineProperty(rgba, index + offset, {
          configurable: true,
          get: () => {
            access.push(channel)
            return PARTY_MANA_COLOR[offset]
          }
        })
      }
      rgba[index + 3] = 255
    }

    expect(isPartySlotPresent(rgba as unknown as Uint8ClampedArray)).toBe(true)
    expect(access).toEqual(Array.from({ length: 50 }, () => ['red', 'green', 'blue']).flat())
  })
})
