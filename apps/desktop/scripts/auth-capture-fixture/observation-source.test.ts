import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { installObservation } from './observe'

type ObservedWorker = {
  postMessage: (...args: unknown[]) => unknown
}

type ObservationWindow = {
  Worker: new (...args: unknown[]) => ObservedWorker
  captureObservation: () => { recognitionRequests: number }
}

function installObservationSource(): {
  window: ObservationWindow
  delegatedMessages: unknown[][]
} {
  const delegatedMessages: unknown[][] = []
  class NativeWorker {
    postMessage(...args: unknown[]): string {
      delegatedMessages.push(args)
      return 'delegated'
    }
  }
  class HTMLMediaElement {
    async play(): Promise<void> {
      return undefined
    }
  }
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    get: () => null,
    set: () => undefined
  })
  class HTMLVideoElement extends HTMLMediaElement {}
  const window = {
    Worker: NativeWorker,
    inspectFixtureFrame: () => ({})
  }
  const navigator = {
    mediaDevices: {
      getDisplayMedia: vi.fn()
    }
  }

  runInNewContext(installObservation, {
    window,
    navigator,
    HTMLMediaElement,
    HTMLVideoElement
  })

  return { window: window as unknown as ObservationWindow, delegatedMessages }
}

describe('generated capture observation source', () => {
  it('nullish messages skip recognition inspection and still delegate postMessage', () => {
    const { window, delegatedMessages } = installObservationSource()
    const worker = new window.Worker()

    expect(worker.postMessage(null)).toBe('delegated')
    expect(worker.postMessage(undefined)).toBe('delegated')

    expect(window.captureObservation().recognitionRequests).toBe(0)
    expect(delegatedMessages).toEqual([[null], [undefined]])
  })

  it('recognize action is read once before the native postMessage call', () => {
    const { window, delegatedMessages } = installObservationSource()
    const action = vi.fn(() => 'recognize')
    const message = Object.defineProperty({}, 'action', { get: action })
    const worker = new window.Worker()

    expect(worker.postMessage(message, 'transfer')).toBe('delegated')

    expect(action).toHaveBeenCalledOnce()
    expect(window.captureObservation().recognitionRequests).toBe(1)
    expect(delegatedMessages).toEqual([[message, 'transfer']])
  })

  it('action getter errors remain before native postMessage', () => {
    const { window, delegatedMessages } = installObservationSource()
    const error = new Error('action failure')
    const message = Object.defineProperty({}, 'action', {
      get: () => {
        throw error
      }
    })
    const worker = new window.Worker()

    expect(() => worker.postMessage(message)).toThrow(error)
    expect(delegatedMessages).toEqual([])
  })
})
