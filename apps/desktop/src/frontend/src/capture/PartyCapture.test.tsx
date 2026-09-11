// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PartyCapture from './PartyCapture'

const capture = vi.hoisted(() => ({
  sources: [],
  selectedSourceId: '',
  sourceRegistered: false,
  starting: false,
  search: { ready: true, slots: [], retryPending: [], connectionFailed: false },
  retrySearch: vi.fn(),
  intervalSeconds: 3,
  stableNicknames: [null, '', 'Alice', null],
  status: 'Capture ready.',
  selectSource: vi.fn(),
  setIntervalSeconds: vi.fn(),
  startCapture: vi.fn(),
  stopCapture: vi.fn()
}))

vi.mock('./usePartyCapture', () => ({ usePartyCapture: () => capture }))

describe('PartyCapture', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root.render(<PartyCapture />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('preserves status and slot order while omitting null and empty lines', () => {
    expect(container.querySelector('pre')?.textContent).toBe('Capture ready.\nSlot 3: Alice')
  })
})
