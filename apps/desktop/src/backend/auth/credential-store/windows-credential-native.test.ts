import { describe, expect, it, vi } from 'vitest'
import { createWindowsSecurityNative } from '../windows-security-native'
import { createWindowsCredentialNative } from './windows-credential-native'

vi.mock('../windows-security-native', () => ({ createWindowsSecurityNative: vi.fn() }))

describe('Windows credential native enumeration connection', () => {
  it('passes the exact directory and complete names through the native boundary without enabling capabilities', async () => {
    const names = ['credential.v1', 'transition.v1', 'unrelated.txt']
    const list = vi.fn(() => names)
    vi.mocked(createWindowsSecurityNative).mockReturnValue({ list } as unknown as ReturnType<
      typeof createWindowsSecurityNative
    >)
    const native = createWindowsCredentialNative()

    await expect(native.list(String.raw`C:\LdbProfile\auth\test`)).resolves.toEqual(names)
    expect(list).toHaveBeenCalledWith(String.raw`C:\LdbProfile\auth\test`)
    expect(native.capabilities).toEqual({
      profileProtection: 'unknown',
      fileMutation: 'unknown',
      namespaceMutation: 'unknown'
    })
  })

  it('propagates native enumeration failure without turning it into an empty list', async () => {
    const error = new Error('Synthetic incomplete enumeration.')
    const list = vi.fn(() => {
      throw error
    })
    vi.mocked(createWindowsSecurityNative).mockReturnValue({ list } as unknown as ReturnType<
      typeof createWindowsSecurityNative
    >)

    await expect(createWindowsCredentialNative().list('directory')).rejects.toBe(error)
  })
})
