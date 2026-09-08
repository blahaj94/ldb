// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SearchResults } from '../../src/frontend/src/search/SearchResults'
import { searchSlot, searchSnapshot } from '../../src/preload/api/search-test-fixture'
import type { SearchSnapshot } from '../../src/preload/common/types/search'
import * as observations from './observe'

type Probe = {
  captureId: string | null
  revision: number
  slots: Array<{
    state: string
    requestId: string | null
    observationRevision: number
    code: string | null
    retryAfterSeconds: number | null
    retryDisabled: boolean | null
    retryCount: number
    statusMatched: boolean
    pending: boolean
  }>
  candidateMask: number
  ocrMask: number
  regionMask: number
  sourceSelected: boolean
  startDisabled: boolean | null
  horizontalOverflow: boolean
  dark: boolean
}
let root: Root
let snapshot: SearchSnapshot
const read = vi.fn()

async function inspect(): Promise<Probe> {
  const script = Reflect.get(observations, 'inspectSearch')
  expect(typeof script, '검색 UI 관측 script').toBe('string')
  return window.eval(script)
}

beforeEach(async () => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(window, 'search', {
    configurable: true,
    value: { controlCharacterSearch: read }
  })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: true })
  })
  const controls =
    '<select><option value="synthetic-private-source">Synthetic</option></select><button>Start</button><pre></pre><div id="results"></div>'
  document.body.innerHTML = controls
  document.querySelector('pre')!.textContent = [1, 2, 3, 4]
    .map((slot) => `Slot ${slot}: ALICE`)
    .join('\n')
  const row = {
    characterId: 'synthetic-character',
    characterName: 'ALICE',
    serverId: 'cain',
    serverName: '카인',
    fame: 12345
  }
  snapshot = searchSnapshot({
    slots: [
      searchSlot({ slot: 0, state: 'success', rows: [row] }),
      searchSlot({ slot: 1, state: 'empty' }),
      searchSlot({ slot: 2, state: 'pending' }),
      searchSlot({
        slot: 3,
        state: 'failure',
        error: { code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: 2 }
      })
    ]
  })
  read.mockImplementation(async () => ({ ok: true, snapshot, raw: 'synthetic-private-value' }))
  root = createRoot(document.getElementById('results')!)
  await act(async () =>
    root.render(
      createElement(SearchResults, {
        view: {
          ready: true,
          slots: snapshot.slots,
          retryPending: [false, false, false, false],
          connectionFailed: false
        },
        retry: vi.fn()
      })
    )
  )
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
})

it('실제 검색 component와 read를 함께 관측하고 원문 대신 상태·mask·비교용 식별자만 반환한다', async () => {
  const probe = await inspect()
  expect(read).toHaveBeenCalledExactlyOnceWith({ action: 'read' })
  expect(probe.slots.map((slot) => slot.state)).toEqual(['success', 'empty', 'pending', 'failure'])
  expect(probe.slots.every((slot) => slot.statusMatched)).toBe(true)
  expect(probe.slots[2].pending).toBe(true)
  expect(probe.slots[3].retryDisabled).toBe(true)
  expect(probe.slots[3].retryCount).toBe(1)
  expect(probe.candidateMask).toBe(1)
  expect(probe.ocrMask).toBe(15)
  expect(probe.regionMask).toBe(15)
  expect(probe.sourceSelected).toBe(true)
  expect(probe.startDisabled).toBe(false)
  expect(probe.dark).toBe(true)
  const serialized = JSON.stringify(probe)
  const hasRawValue = [
    'ALICE',
    'synthetic-character',
    'synthetic-private-source',
    'synthetic-private-value'
  ].some((value) => serialized.includes(value))
  expect(hasRawValue).toBe(false)
})

it('main 상태가 맞아도 실제 고정 문구가 잘못되면 일치로 판정하지 않는다', async () => {
  document.querySelector('[aria-label="슬롯 2 검색"] [role="status"]')!.textContent =
    'Incorrect display'
  const probe = await inspect()
  expect(probe.slots[1].statusMatched).toBe(false)
})

it('후보 이름만 맞고 field가 누락된 화면은 후보 일치 mask에 포함하지 않는다', async () => {
  document.querySelector('[aria-label="슬롯 1 검색"] ol')!.textContent = 'ALICE'
  const probe = await inspect()
  expect(probe.candidateMask).toBe(0)
})

it('429 main 만료 값과 실제 disabled 상태를 별도로 관측한다', async () => {
  snapshot = {
    ...snapshot,
    revision: 2,
    slots: snapshot.slots.map((slot) => {
      const isLimited = slot.slot === 3
      return isLimited
        ? { ...slot, error: { code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: 0 } }
        : slot
    })
  }
  const probe = await inspect()
  expect(probe.slots[3].retryAfterSeconds).toBe(0)
  expect(probe.slots[3].retryDisabled).toBe(true)
})

it('검색 영역 누락을 정상 네 slot 화면으로 세지 않는다', async () => {
  document.querySelector('[aria-label="슬롯 4 검색"]')!.remove()
  const probe = await inspect()
  expect(probe.regionMask).toBe(7)
  expect(probe.slots[3].statusMatched).toBe(false)
})

it('관측용 read 실패는 원문 오류를 반환하지 않고 고정 실패로 끝낸다', async () => {
  read.mockRejectedValueOnce(new Error('synthetic-private-value'))
  const script = Reflect.get(observations, 'inspectSearch')
  expect(typeof script, '검색 UI 관측 script').toBe('string')
  let failure = ''
  try {
    await window.eval(script)
  } catch (error) {
    failure = String(error)
  }
  expect(failure).toBe('Error: Search fixture state read failed')
})
