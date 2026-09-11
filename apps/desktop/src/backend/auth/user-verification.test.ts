import { describe, expect, it } from 'vitest'
import { AuthHttpFailure } from './http'
import { verificationFailureNotice } from './user-verification'

function createFailureWithCodeGetter(codes: readonly AuthHttpFailure['code'][]): {
  failure: AuthHttpFailure
  reads: AuthHttpFailure['code'][]
} {
  const failure = new AuthHttpFailure('unavailable')
  const reads: AuthHttpFailure['code'][] = []

  Object.defineProperty(failure, 'code', {
    configurable: true,
    get: () => {
      const code = codes[reads.length]
      if (code == null) {
        throw new Error('Unexpected AuthHttpFailure code read.')
      }
      reads.push(code)
      return code
    }
  })

  return { failure, reads }
}

describe('verificationFailureNotice', () => {
  it('인증 오류가 아니면 code를 읽지 않고 서비스 불가 notice를 반환한다', () => {
    let codeReads = 0
    const error = {}
    Object.defineProperty(error, 'code', {
      get: () => {
        codeReads += 1
        return 'network'
      }
    })

    expect(verificationFailureNotice(error)).toBe('AUTH_SERVICE_UNAVAILABLE')
    expect(codeReads).toBe(0)
  })

  it('인증 오류는 code를 한 번 확인하고 재인증 notice를 반환한다', () => {
    const { failure, reads } = createFailureWithCodeGetter(['authentication-required'])

    expect(verificationFailureNotice(failure)).toBe('REAUTH_REQUIRED')
    expect(reads).toEqual(['authentication-required'])
  })

  it('network 오류는 기존 code 조회 순서와 횟수로 network notice를 반환한다', () => {
    const { failure, reads } = createFailureWithCodeGetter(['unavailable', 'network'])

    expect(verificationFailureNotice(failure)).toBe('NETWORK_UNAVAILABLE')
    expect(reads).toEqual(['unavailable', 'network'])
  })

  it('그 밖의 HTTP 오류는 기존 code 조회 횟수로 서비스 불가 notice를 반환한다', () => {
    const { failure, reads } = createFailureWithCodeGetter(['unavailable', 'unavailable'])

    expect(verificationFailureNotice(failure)).toBe('AUTH_SERVICE_UNAVAILABLE')
    expect(reads).toEqual(['unavailable', 'unavailable'])
  })
})
