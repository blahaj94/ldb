import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createAuthCoordinator } from './coordinator'
import { createPkce, isCanonicalOpaque } from './pkce'
import {
  AuthProtocolFailure,
  parseReturnUrl,
  validateApiOrigin,
  validateBrowserLaunchUrl,
  validateReturnTarget
} from './protocol'
import { API_ORIGIN, CODE, RETURN_TARGET, createAuthHarness } from './auth-test-fixtures'

describe('Desktop auth PKCE와 URL 경계', () => {
  it.each([
    {
      name: 'API origin',
      validate: () => validateApiOrigin('https://example.test/'),
      laterGetter: 'pathname'
    },
    {
      name: 'return target',
      validate: () => validateReturnTarget('test-ldb://auth/return'),
      laterGetter: 'port'
    }
  ])(
    '$name은 username 실패 뒤 password를 건너뛰고 이후 getter를 평가한다',
    ({ validate, laterGetter }) => {
      const access: string[] = []
      class ObservedUrl {
        protocol: string
        constructor(raw: string) {
          this.protocol = raw.startsWith('test-ldb:') ? 'test-ldb:' : 'https:'
        }
        username = 'user'
        get password(): string {
          access.push('password')
          throw new Error('password must be skipped')
        }
        get pathname(): string {
          access.push('pathname')
          throw new Error('sentinel later getter')
        }
        get port(): string {
          access.push('port')
          throw new Error('sentinel later getter')
        }
        search = ''
        hash = ''
        origin = 'https://example.test'
        toString(): string {
          return 'test-ldb://auth/return'
        }
      }
      vi.stubGlobal('URL', ObservedUrl)

      try {
        expect(validate).toThrow('sentinel later getter')
        expect(access).toEqual([laterGetter])
      } finally {
        vi.unstubAllGlobals()
      }
    }
  )

  it('non-string Proxy는 URL 내부 접근 없이 AuthProtocolFailure로 거절한다', () => {
    const value = new Proxy(
      {},
      {
        get: () => {
          throw new Error('unexpected get')
        },
        has: () => {
          throw new Error('unexpected has')
        }
      }
    )

    expect(() => validateApiOrigin(value as unknown as string)).toThrow(AuthProtocolFailure)
  })

  it.each([null, undefined, 42, true, {}, new String('A'.repeat(43))])(
    '문자열이 아닌 PKCE 입력 %p를 정규식과 coercion 없이 거절한다',
    (value) => {
      expect(isCanonicalOpaque(value)).toBe(false)
    }
  )

  it('문자열이 아닌 Proxy 입력은 내부 접근 없이 거절한다', () => {
    const value = new Proxy(
      {},
      {
        get: () => {
          throw new Error('unexpected get')
        },
        has: () => {
          throw new Error('unexpected has')
        }
      }
    )

    expect(isCanonicalOpaque(value)).toBe(false)
  })

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
    expect(() => validateBrowserLaunchUrl(`${valid}&ticket=${ticket}`, API_ORIGIN)).toThrow(
      'Authentication URL is invalid.'
    )
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
    expect(() => parseReturnUrl(`${valid.replace(CODE, `${CODE}=`)}`, RETURN_TARGET)).toThrow(
      'Authentication URL is invalid.'
    )
  })

  it.each(['?', '#', '?#', '#?'])(
    'return target의 빈 delimiter %s는 coordinator 설정 단계에서 거절한다',
    (delimiter) => {
      const harness = createAuthHarness()
      const returnTarget = `${RETURN_TARGET}${delimiter}`

      expect(() => createAuthCoordinator({ ...harness.dependencies, returnTarget })).toThrow(
        AuthProtocolFailure
      )
      expect(harness.http.createLoginRequest).not.toHaveBeenCalled()
      expect(harness.browser.open).not.toHaveBeenCalled()
    }
  )

  it.each([RETURN_TARGET, 'test-ldb:/auth/return', 'test-ldb://auth/return%3F%23'])(
    '정상 return target %s와 code query 복귀를 그대로 허용한다',
    (returnTarget) => {
      expect(validateReturnTarget(returnTarget)).toBe(returnTarget)
      expect(parseReturnUrl(`${returnTarget}?code=${CODE}`, returnTarget)).toEqual({ code: CODE })
    }
  )

  it.each(['javascript:alert', 'data:text/plain,value', 'ftp://auth/return'])(
    'app private protocol이 될 수 없는 built-in target %s을 거절한다',
    (target) => {
      expect(() => parseReturnUrl(`${target}?code=${CODE}`, target)).toThrow()
    }
  )

  it('Windows drive prefix와 충돌하는 one-letter private scheme을 거절한다', () => {
    expect(() => validateReturnTarget('x://auth/return')).toThrow(AuthProtocolFailure)
  })
})
