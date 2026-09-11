// @vitest-environment jsdom
import { runInNewContext } from 'node:vm'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthCoordinator } from '../../src/backend/auth/types'
import { installObservation } from './observe'
import { sandboxInspectionSource, smoke } from './smoke'

describe('generated sandbox inspection source', () => {
  it('Electron 노출 시 require getter를 읽지 않는다', () => {
    const reads: string[] = []
    const window = Object.defineProperties(
      {},
      {
        electron: { get: () => (reads.push('electron'), {}) },
        require: {
          get: () => {
            throw new Error('require getter must stay skipped')
          }
        }
      }
    )

    expect(runInNewContext(sandboxInspectionSource, { window })).toBe(false)
    expect(reads).toEqual(['electron'])
  })

  it('Electron이 없으면 require를 한 번 읽어 sandbox 부재를 확인한다', () => {
    const reads: string[] = []
    const window = Object.defineProperties(
      {},
      {
        electron: { get: () => (reads.push('electron'), undefined) },
        require: { get: () => (reads.push('require'), undefined) }
      }
    )

    expect(runInNewContext(sandboxInspectionSource, { window })).toBe(true)
    expect(reads).toEqual(['electron', 'require'])
  })

  it('생성 source는 require 검사를 electron guard 뒤에 독립적으로 둔다', () => {
    expect(sandboxInspectionSource).toContain('if (!hasNoElectron)')
    expect(sandboxInspectionSource).toContain(
      'const hasNoRequire = typeof window.require === "undefined";'
    )
    expect(sandboxInspectionSource).not.toContain(
      'const hasNoRequire = hasNoElectron && typeof window.require'
    )
  })
})

const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:timers/promises', () => {
  const setTimeout = async (milliseconds: number): Promise<void> => {
    clock.now += milliseconds
  }
  return { setTimeout, default: { setTimeout } }
})

beforeEach(() => {
  clock.now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
  vi.spyOn(console, 'log').mockImplementation((message) => {
    // 이후 logout 경로와 독립적으로 실제 smoke의 capture 성공 판정까지만 실행한다.
    const hasPassedCapture = message === 'Capture fixture real media/OCR PASS'
    if (hasPassedCapture) {
      throw new Error('SYNTHETIC_CAPTURE_ACCEPTED')
    }
  })
})
afterEach(() => vi.restoreAllMocks())

async function runCapture(displayLines: string[], nicknameMatchedSlots: number): Promise<void> {
  let phase = 'signedOut'
  let isActive = false
  const mainObservation = {
    displayRequests: 1,
    displayAllowed: 1,
    nicknameInvokes: 4,
    nicknameAccepted: 4,
    nicknameMatchedSlots
  }
  function renderHome(): void {
    document.body.innerHTML = `<select><option value="">Select a window</option><option value="synthetic">LDB Synthetic Capture Source</option></select><button disabled>Start</button><pre></pre>`
    const select = document.querySelector('select')!
    const start = document.querySelector('button')!
    select.onchange = () => {
      start.disabled = false
    }
    start.onclick = () => {
      isActive = true
      document.querySelector('pre')!.textContent = [
        'Capture ready at 1920×1080.',
        ...displayLines
      ].join('\n')
    }
  }
  document.body.innerHTML = '<button>Google로 계속하기</button>'
  document.querySelector('button')!.onclick = () => {
    phase = 'waitingBrowser'
  }
  Object.assign(window, {
    captureObservation: () => ({
      requests: isActive ? 1 : 0,
      streams: isActive ? 1 : 0,
      workers: 1,
      terminated: 0,
      ended: false,
      width: 1920,
      height: 1080,
      frameWidth: 1920,
      frameHeight: 1080,
      allSlotsPresent: true
    })
  })
  const browserWindow = {
    webContents: {
      executeJavaScript: async (source: string): Promise<unknown> => {
        const isObservationInstall = source === installObservation
        return isObservationInstall ? true : window.eval(source)
      }
    }
  } as unknown as BrowserWindow
  const coordinator = { getSnapshot: () => ({ phase }) } as AuthCoordinator
  await smoke(
    browserWindow,
    coordinator,
    async () => {
      document.body.innerHTML = '<button>시작하기</button>'
      document.querySelector('button')!.onclick = renderHome
    },
    mainObservation
  )
}

const completeLines = [1, 2, 3, 4].map((slot) => `Slot ${slot}: ALICE`)
describe('automatic smoke synthetic results', () => {
  it('네 slot의 정확한 표시와 main 통지가 모두 일치해야 capture 성공에 도달한다', async () => {
    await expect(runCapture(completeLines, 0b1111)).rejects.toThrow('SYNTHETIC_CAPTURE_ACCEPTED')
  })
  it.each([
    { name: 'slot 4 표시 누락', lines: completeLines.slice(0, 3), mask: 0b1111 },
    {
      name: 'slot 4 표시 오인식',
      lines: [...completeLines.slice(0, 3), 'Slot 4: ALICEX'],
      mask: 0b1111
    },
    { name: '표시만 일치', lines: completeLines, mask: 0 },
    { name: 'slot 4 통지 누락', lines: completeLines, mask: 0b0111 },
    { name: '같은 slot 통지 중복', lines: completeLines, mask: 0b0001 },
    { name: '통지만 일치', lines: ['Slot 1: ALICE'], mask: 0b1111 }
  ])('$name이면 capture 성공으로 진행하지 않는다', async ({ lines, mask }) => {
    await expect(runCapture(lines, mask)).rejects.toThrow(
      'Capture fixture observation deadline exceeded'
    )
  })
})
