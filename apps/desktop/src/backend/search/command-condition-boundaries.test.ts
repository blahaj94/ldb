import { describe, expect, it, vi } from 'vitest'
import { parseSearchControl } from './commands'

describe('search command parser condition boundaries', () => {
  it('symbol key는 Object.hasOwn에 전달하지 않고 거절한다', () => {
    const symbolKey = Symbol('unexpected')
    const command = { action: 'read', [symbolKey]: true }
    const hasOwn = vi.spyOn(Object, 'hasOwn')

    try {
      expect(parseSearchControl([command])).toBeNull()
      expect(hasOwn.mock.calls.some(([, key]) => key === symbolKey)).toBe(false)
      expect(hasOwn.mock.calls.some(([, key]) => key === 'action')).toBe(true)
    } finally {
      hasOwn.mockRestore()
    }
  })

  it('key count가 달라도 schema 이후 every를 실행하고 Proxy 평가 순서를 보존한다', () => {
    const events: string[] = []
    const symbolKey = Symbol('unexpected')
    const command = new Proxy(
      { action: 'read', [symbolKey]: true },
      {
        get(target, property, receiver) {
          events.push(`get:${String(property)}`)
          return Reflect.get(target, property, receiver)
        },
        ownKeys(target) {
          events.push('ownKeys')
          return Reflect.ownKeys(target)
        }
      }
    )
    const hasOwn = vi.spyOn(Object, 'hasOwn')

    try {
      expect(parseSearchControl([command])).toBeNull()

      const getterIndex = events.indexOf('get:action')
      const lastOwnKeysIndex = events.lastIndexOf('ownKeys')
      expect(getterIndex).toBeGreaterThanOrEqual(0)
      expect(lastOwnKeysIndex).toBeGreaterThan(getterIndex)
      expect(hasOwn.mock.calls.some(([, key]) => key === 'action')).toBe(true)
    } finally {
      hasOwn.mockRestore()
    }
  })
})
