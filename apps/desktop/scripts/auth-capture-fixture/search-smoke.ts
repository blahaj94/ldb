import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeTheme, type BrowserWindow } from 'electron'
import type { AuthCoordinator } from '../../src/backend/auth/types'
import type { CaptureObservation } from './capture-observation'
import type { createFixtureSearch } from './search-effects'
import { createCaptureActions, until } from './actions'
import { installObservation } from './observe'
import { inspectSearch, type SearchUiObservation } from './search-observation'

type Slot = SearchUiObservation['slots'][number]
function sameRequest(before: Slot, after: Slot): boolean {
  const hasSameId = before.requestId != null && before.requestId === after.requestId
  const hasSameObservation = before.observationRevision === after.observationRevision
  return hasSameId && hasSameObservation
}
function hasState(view: SearchUiObservation, state: string): boolean {
  const hasRegions = view.regionMask === 15
  const hasMatchingSlots = view.slots.every((slot) => {
    const isState = slot.state === state
    return isState && slot.statusMatched
  })
  return hasRegions && hasMatchingSlots
}

export async function smokeCharacterSearch(
  window: BrowserWindow,
  coordinator: AuthCoordinator,
  completeLogin: () => Promise<void>,
  main: CaptureObservation,
  search: ReturnType<typeof createFixtureSearch>
): Promise<void> {
  const actions = createCaptureActions({ window, coordinator, completeLogin })
  const { evaluate, click, observe, hasText, enterHome, selectSyntheticSource } = actions
  const read = (): Promise<SearchUiObservation> =>
    evaluate(inspectSearch) as Promise<SearchUiObservation>
  let previousCapture: string | null = null
  let stage = 'setup'
  function enterStage(next: string): void {
    stage = next
    console.log(`Capture fixture search stage: ${stage}`)
  }
  async function waitFor(
    predicate: (view: SearchUiObservation) => boolean,
    milliseconds = 10_000
  ): Promise<SearchUiObservation> {
    let view = await read()
    await until(async () => {
      view = await read()
      return predicate(view)
    }, milliseconds)
    return view
  }
  async function start(): Promise<SearchUiObservation> {
    const before = await observe()
    const displayRequests = main.displayRequests
    const displayAllowed = main.displayAllowed
    await click('Start')
    await until(() => hasText('Capture ready at 1920×1080.'), 30_000)
    const view = await waitFor((current) => {
      const hasNewCapture = current.captureId != null && current.captureId !== previousCapture
      const hasOcr = current.ocrMask === 15 && main.nicknameMatchedSlots === 15
      return hasNewCapture && hasOcr
    }, 30_000)
    const active = await observe()
    assert.equal(active.streams, before.streams + 1)
    assert.equal(active.workers, before.workers + 1)
    assert.equal(active.ended, false)
    assert.equal(active.frameWidth, 1920)
    assert.equal(active.frameHeight, 1080)
    assert.equal(active.allSlotsPresent, true)
    assert.equal(main.displayRequests, displayRequests + 1)
    assert.equal(main.displayAllowed, displayAllowed + 1)
    previousCapture = view.captureId
    return view
  }
  async function stop(): Promise<void> {
    await click('Stop')
    await waitFor((view) => {
      const hasEnded = view.captureId === null && view.ocrMask === 0
      return hasEnded && hasState(view, 'idle')
    })
    await until(async () => {
      const state = await observe()
      return (
        state.ended && state.terminated === state.workers && state.clearedVideos === state.streams
      )
    })
  }
  async function retry({
    slot,
    allowDisabled = false
  }: {
    slot: number
    allowDisabled?: boolean
  }): Promise<void> {
    const retryScript = `(() => {
      const region = document.querySelector('[aria-label="슬롯 ${slot + 1} 검색"]');
      const button = [...(region?.querySelectorAll('button') ?? [])].find(item => item.textContent?.trim() === '다시 시도');
      const canClick = button != null && (${allowDisabled} || !button.disabled);
      if (!canClick) return false;
      button.click();
      return true;
    })()`
    assert.equal(await evaluate(retryScript, true), true)
  }
  try {
    assert.equal(
      await evaluate(
        'typeof window.electron === "undefined" && typeof window.require === "undefined"'
      ),
      true
    )
    assert.equal(await evaluate(installObservation), true)
    search.selectScenario('empty')
    await enterHome()
    await selectSyntheticSource()
    enterStage('empty')
    await start()
    const empty = await waitFor((view) => hasState(view, 'empty'))
    const emptyMask = empty.slots.reduce((mask, slot, index) => {
      const isEmpty = slot.state === 'empty' && slot.statusMatched
      return isEmpty ? mask | (1 << index) : mask
    }, 0)
    assert.equal(emptyMask, 15)

    await stop()
    enterStage('mixed')
    search.queueScenarios(['failure', 'failure', 'pending', 'rate-limit'])
    await start()
    const mixed = await waitFor((view) => {
      const failureCount = view.slots.filter((slot) => slot.code === 'INTERNAL_SERVER_ERROR').length
      const pendingCount = view.slots.filter((slot) => slot.state === 'pending').length
      const limitedCount = view.slots.filter((slot) => slot.code === 'SEARCH_RATE_LIMITED').length
      const matchesUi = view.regionMask === 15 && view.slots.every((slot) => slot.statusMatched)
      return matchesUi && failureCount === 2 && pendingCount === 1 && limitedCount === 1
    })
    // HTTP 도착 순서를 slot 번호로 가정하지 않고 실제 수용한 상태에서 역할을 찾는다.
    const failures = mixed.slots.flatMap((slot, index) =>
      slot.code === 'INTERNAL_SERVER_ERROR' ? [index] : []
    )
    const pendingSlot = mixed.slots.findIndex((slot) => slot.state === 'pending')
    const limitedSlot = mixed.slots.findIndex((slot) => slot.code === 'SEARCH_RATE_LIMITED')
    const limitedBefore = mixed.slots[limitedSlot]
    const hasPositiveWait =
      limitedBefore.retryAfterSeconds != null && limitedBefore.retryAfterSeconds > 0
    assert.equal(hasPositiveWait && limitedBefore.retryDisabled === true, true)
    const mixedRequests = search.counts.requests
    search.selectScenario('success')
    assert.equal(search.counts.requests, mixedRequests)
    await retry({ slot: failures[0] })
    const firstRetry = await waitFor(
      (view) => view.slots[failures[0]].state === 'success' && view.slots[failures[0]].statusMatched
    )
    const independentRetry =
      mixed.slots.every((before, index) => {
        const isRetried = index === failures[0]
        const after = firstRetry.slots[index]
        return isRetried
          ? before.requestId !== after.requestId
          : sameRequest(before, after) && before.state === after.state
      }) && search.counts.requests === mixedRequests + 1
    assert.equal(independentRetry, true)

    enterStage('rate-wait')
    const beforeBlockedUi = await read()
    const blockedSlot = beforeBlockedUi.slots[limitedSlot]
    const isStillWaiting =
      blockedSlot.retryAfterSeconds != null &&
      blockedSlot.retryAfterSeconds > 0 &&
      blockedSlot.retryDisabled === true
    assert.equal(isStillWaiting, true)
    const beforeBlocked = search.counts.requests
    await retry({ slot: limitedSlot, allowDisabled: true })
    await read()
    assert.equal(search.counts.requests, beforeBlocked)
    const expired = await waitFor(
      (view) =>
        view.slots[limitedSlot].retryAfterSeconds === 0 &&
        view.slots[limitedSlot].retryDisabled === false
    )
    const rateWait =
      hasPositiveWait &&
      isStillWaiting &&
      sameRequest(limitedBefore, expired.slots[limitedSlot]) &&
      expired.slots[limitedSlot].code === 'SEARCH_RATE_LIMITED' &&
      expired.slots[limitedSlot].statusMatched
    const rateNoAutoGet = search.counts.requests === beforeBlocked
    assert.equal(rateWait && rateNoAutoGet, true)
    await retry({ slot: limitedSlot })
    await retry({ slot: failures[1] })
    enterStage('timeout')
    const timedOut = await waitFor(
      (view) =>
        view.slots[pendingSlot].code === 'SEARCH_TIMEOUT' && view.slots[pendingSlot].statusMatched,
      20_000
    )
    const timeout =
      sameRequest(mixed.slots[pendingSlot], timedOut.slots[pendingSlot]) &&
      timedOut.slots[pendingSlot].retryDisabled === false
    assert.equal(timeout, true)
    await retry({ slot: pendingSlot })
    await waitFor((view) => view.candidateMask === 15 && hasState(view, 'success'))

    await stop()
    enterStage('pending-logout')
    search.selectScenario('pending')
    await start()
    const beforeLogout = await waitFor((view) => hasState(view, 'pending'))
    const abortsBeforeLogout = search.counts.pendingAborts
    await click('이 기기 로그아웃')
    await until(() => hasText('Google로 계속하기'))
    await until(async () => {
      const state = await observe()
      return (
        state.ended &&
        state.terminated === state.workers &&
        search.counts.pendingAborts === abortsBeforeLogout + 4
      )
    })
    const stopped = await observe()
    const stoppedUi = await read()
    const pendingCleanup =
      stopped.ended &&
      stopped.stops === stopped.streams &&
      stopped.clearedVideos === stopped.streams &&
      stoppedUi.captureId === null &&
      stoppedUi.regionMask === 0 &&
      stoppedUi.ocrMask === 0
    assert.equal(pendingCleanup, true)
    const requestsBeforeQuiet = search.counts.requests
    const invokesBeforeQuiet = main.nicknameInvokes
    await delay(3_200)
    assert.equal((await observe()).recognitionRequests, stopped.recognitionRequests)
    assert.equal(main.nicknameInvokes, invokesBeforeQuiet)
    assert.equal(search.counts.requests, requestsBeforeQuiet)

    enterStage('relogin')
    await enterHome()
    const blank = await read()
    const afterLogin = await observe()
    const relogin =
      blank.captureId === null &&
      !blank.sourceSelected &&
      blank.startDisabled === true &&
      hasState(blank, 'idle') &&
      afterLogin.streams === stopped.streams &&
      afterLogin.workers === stopped.workers &&
      search.counts.requests === requestsBeforeQuiet
    assert.equal(relogin, true)
    search.selectScenario('success')
    await selectSyntheticSource()
    const restarted = await start()
    const newCapture = restarted.captureId != null && restarted.captureId !== beforeLogout.captureId
    const complete = await waitFor((view) => view.candidateMask === 15 && hasState(view, 'success'))
    assert.equal(newCapture, true)
    enterStage('layout')
    await inspectLayouts(window, read)
    enterStage('final-cleanup')
    await stop()
    await click('이 기기 로그아웃')
    await until(() => hasText('Google로 계속하기'))
    const final = await observe()
    assert.equal(
      final.ended && final.terminated === final.workers && final.stops === final.streams,
      true
    )
    assert.equal(main.displayRequests, 4)
    assert.equal(main.displayAllowed, 4)
    assert.equal(search.counts.requests, 20)
    assert.equal(search.counts.pendingAborts, 5)
    const evidence = {
      emptyMask,
      candidateMask: complete.candidateMask,
      independentRetry,
      timeout,
      rateWait,
      rateNoAutoGet,
      pendingCleanup,
      relogin,
      newCapture,
      displayRequests: main.displayRequests,
      displayAllowed: main.displayAllowed,
      searchRequests: search.counts.requests,
      pendingAborts: search.counts.pendingAborts
    }
    console.log(`Capture fixture search evidence: ${JSON.stringify(evidence)}`)
  } catch {
    console.error(`Capture fixture search stage FAIL: ${stage}`)
    throw new Error('Capture fixture search verification failed')
  }
}

async function inspectLayouts(
  window: BrowserWindow,
  read: () => Promise<SearchUiObservation>
): Promise<void> {
  const originalSize = window.getContentSize()
  const originalTheme = nativeTheme.themeSource
  let samples = 0
  let overflowCount = 0
  let themeMismatchCount = 0
  try {
    for (const width of [640, 1100]) {
      for (const theme of ['light', 'dark'] as const) {
        window.setContentSize(width, 800)
        nativeTheme.themeSource = theme
        await delay(150)
        const view = await read()
        samples += 1
        overflowCount += Number(view.horizontalOverflow)
        themeMismatchCount += Number(view.dark !== (theme === 'dark'))
      }
    }
  } finally {
    window.setContentSize(originalSize[0], originalSize[1])
    nativeTheme.themeSource = originalTheme
  }
  // 보조 layout 관측이며 core 상태 검증이나 공식 시각 비교의 PASS로 합치지 않는다.
  console.log(
    `Capture fixture layout evidence: ${JSON.stringify({ samples, overflowCount, themeMismatchCount })}`
  )
}
