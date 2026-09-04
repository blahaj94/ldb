import { describe, expect, it } from 'vitest'
import { findSelectedSource, isCaptureRequestAllowed } from './capture-policy'

describe('캡처 정책', () => {
  it('현재 window source 목록에 있는 source만 반환한다', () => {
    const sources = [
      { id: 'window:1:0', name: 'Game' },
      { id: 'window:2:0', name: 'Other app' }
    ]

    expect(findSelectedSource(sources, 'window:1:0')).toEqual({ id: 'window:1:0', name: 'Game' })
    expect(findSelectedSource(sources, 'screen:0:0')).toBeNull()
  })

  it('선택된 source가 있는 main frame의 사용자 video 요청만 허용한다', () => {
    expect(
      isCaptureRequestAllowed({
        hasSelectedSource: true,
        isMainFrame: true,
        videoRequested: true,
        audioRequested: false,
        userGesture: true
      })
    ).toBe(true)

    expect(
      isCaptureRequestAllowed({
        hasSelectedSource: true,
        isMainFrame: false,
        videoRequested: true,
        audioRequested: false,
        userGesture: true
      })
    ).toBe(false)
    expect(
      isCaptureRequestAllowed({
        hasSelectedSource: true,
        isMainFrame: true,
        videoRequested: true,
        audioRequested: true,
        userGesture: true
      })
    ).toBe(false)
    expect(
      isCaptureRequestAllowed({
        hasSelectedSource: false,
        isMainFrame: true,
        videoRequested: true,
        audioRequested: false,
        userGesture: true
      })
    ).toBe(false)
  })
})
