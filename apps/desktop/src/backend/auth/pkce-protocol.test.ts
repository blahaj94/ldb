import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createPkce } from './pkce'
import { parseReturnUrl, validateBrowserLaunchUrl } from './protocol'
import { API_ORIGIN, CODE, RETURN_TARGET } from './auth-test-fixtures'

describe('Desktop auth PKCE와 URL 경계', () => {
  it('로그인마다 독립된 32-byte verifier와 ASCII S256 challenge를 만든다', () => {
    const firstBytes = Buffer.alloc(32, 1)
    const secondBytes = Buffer.alloc(32, 2)
    const bytes = vi.fn().mockReturnValueOnce(firstBytes).mockReturnValueOnce(secondBytes)

    const first = createPkce(bytes)
    const second = createPkce(bytes)

    expect(first.verifier).toBe(firstBytes.toString('base64url'))
    expect(first.verifier).toHaveLength(43)
    expect(first.challenge).toBe(
      createHash('sha256').update(first.verifier, 'ascii').digest('base64url')
    )
    expect(second.verifier).not.toBe(first.verifier)
    expect(bytes).toHaveBeenNthCalledWith(1, 32)
    expect(bytes).toHaveBeenNthCalledWith(2, 32)
  })

  it('정확한 API origin, path와 canonical ticket인 browser URL만 허용한다', () => {
    const ticket = Buffer.alloc(32, 8).toString('base64url')
    const valid = `${API_ORIGIN}/auth/login/authorize?ticket=${ticket}`

    expect(validateBrowserLaunchUrl(valid, API_ORIGIN)).toBe(valid)
    expect(() => validateBrowserLaunchUrl(`${valid}&next=/capture`, API_ORIGIN)).toThrow()
    expect(() =>
      validateBrowserLaunchUrl(valid.replace('api.', 'api.attacker.'), API_ORIGIN)
    ).toThrow()
    expect(() => validateBrowserLaunchUrl(valid.replace('https:', 'http:'), API_ORIGIN)).toThrow()
    expect(() =>
      validateBrowserLaunchUrl(valid.replace(ticket, `${ticket}=`), API_ORIGIN)
    ).toThrow()
  })

  it('등록 target의 code 하나인 canonical 복귀 URL만 반환한다', () => {
    const valid = `${RETURN_TARGET}?code=${CODE}`

    expect(parseReturnUrl(valid, RETURN_TARGET)).toEqual({ code: CODE })
    expect(() => parseReturnUrl(`${valid}&state=leaked`, RETURN_TARGET)).toThrow()
    expect(() =>
      parseReturnUrl(`${RETURN_TARGET}?code=${CODE}&code=${CODE}`, RETURN_TARGET)
    ).toThrow()
    expect(() => parseReturnUrl(valid.replace('return', 'other'), RETURN_TARGET)).toThrow()
    expect(() => parseReturnUrl(`${valid}#fragment`, RETURN_TARGET)).toThrow()
    expect(() => parseReturnUrl(`${valid} `, RETURN_TARGET)).toThrow()
    expect(() =>
      parseReturnUrl(`${RETURN_TARGET}?code=${CODE.slice(0, -1)}`, RETURN_TARGET)
    ).toThrow()
  })
})
