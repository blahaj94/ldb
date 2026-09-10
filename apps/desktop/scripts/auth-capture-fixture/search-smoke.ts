import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeTheme, type BrowserWindow } from 'electron'
import type { AuthCoordinator } from '../../src/backend/auth/types'
import type { CaptureObservation } from './capture-observation'
import type { createFixtureSearch } from './search-effects'
import { createCaptureActions, until } from './actions'
import { installObservation } from './observe'
import {
  assertScenarioSelectionQuiet,
  createIndependentRetryDiagnostic,
  rethrowMixedSearchFailure,
  type SearchDiagnostic
} from './search-diagnostic'
import { inspectSearch, type SearchUiObservation } from './search-observation'

type Slot = SearchUiObservation['slots'][number]
function hasRetryWait(slot: Slot): slot is Slot & { retryAfterSeconds: number } {
  const hasWait = slot.retryAfterSeconds != null
  return hasWait
}

function sameRequest({ before, after }: { before: Slot; after: Slot }): boolean {
  const hasRequestId = before.requestId != null
  const hasSameId = hasRequestId && before.requestId === after.requestId
  const hasSameObservation = before.observationRevision === after.observationRevision
  const isSameRequest = hasSameId && hasSameObservation
  return isSameRequest
}
function hasState(view: SearchUiObservation, state: string): boolean {
  const hasRegions = view.regionMask === 15
  const hasMatchingSlots = view.slots.every((slot) => {
    const isState = slot.state === state
    const hasMatchingState = isState && slot.statusMatched
    return hasMatchingState
  })
  const hasMatchingView = hasRegions && hasMatchingSlots
  return hasMatchingView
}

function createRetryScript({
  slot,
  allowDisabled
}: {
  slot: number
  allowDisabled: boolean
}): string {
  const retryScript = `(() => {
      const region = document.querySelector('[aria-label="슬롯 ${slot + 1} 검색"]');
      const button = [...(region?.querySelectorAll('button') ?? [])].find(item => {
        const isRetry = item.textContent?.trim() === '다시 시도';
        return isRetry;
      });
      const hasButton = button != null;
      const allowsDisabledClick = ${allowDisabled};
      const canClick = hasButton && (allowsDisabledClick || !button.disabled);
      if (!canClick) {
        return false;
      }
      button.click();
      return true;
    })()`
  return retryScript
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
  let diagnostic: SearchDiagnostic | null = null
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
      const hasCaptureId = current.captureId != null
      const hasNewCapture = hasCaptureId && current.captureId !== previousCapture
      const hasAllOcrSlots = current.ocrMask === 15
      const hasOcr = hasAllOcrSlots && main.nicknameMatchedSlots === 15
      const hasReadyCapture = hasNewCapture && hasOcr
      return hasReadyCapture
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
      const hasNoCapture = view.captureId === null
      const hasEnded = hasNoCapture && view.ocrMask === 0
      const hasIdleView = hasEnded && hasState(view, 'idle')
      return hasIdleView
    })
    await until(async () => {
      const state = await observe()
      const hasTerminatedWorkers = state.ended && state.terminated === state.workers
      const hasClearedVideos = hasTerminatedWorkers && state.clearedVideos === state.streams
      return hasClearedVideos
    })
  }
  async function retry({
    slot,
    allowDisabled = false,
    diagnosticCheck
  }: {
    slot: number
    allowDisabled?: boolean
    diagnosticCheck?: 'first-retry-click'
  }): Promise<void> {
    const retryScript = createRetryScript({ slot, allowDisabled })
    const clicked = await evaluate(retryScript, true)
    if (diagnosticCheck != null) {
      diagnostic = {
        stage: 'mixed',
        check: diagnosticCheck,
        actual: { clicked: clicked === true },
        expected: { clicked: true }
      }
    }
    assert.equal(clicked, true)
  }
  try {
    const sandboxInspectionSource = `(() => {
      const hasNoElectron = typeof window.electron === "undefined";
      if (!hasNoElectron) {
        return false;
      }
      const hasNoRequire = typeof window.require === "undefined";
      return hasNoRequire;
    })()`
    assert.equal(await evaluate(sandboxInspectionSource), true)
    assert.equal(await evaluate(installObservation), true)
    search.selectScenario('empty')
    await enterHome()
    await selectSyntheticSource()
    enterStage('empty')
    await start()
    const empty = await waitFor((view) => hasState(view, 'empty'))
    const emptyMask = empty.slots.reduce((mask, slot, index) => {
      const hasEmptyState = slot.state === 'empty'
      const isEmpty = hasEmptyState && slot.statusMatched
      return isEmpty ? mask | (1 << index) : mask
    }, 0)
    assert.equal(emptyMask, 15)

    await stop()
    enterStage('mixed')
    search.queueScenarios(['failure', 'failure', 'pending', 'rate-limit'])
    diagnostic = {
      stage: 'mixed',
      check: 'capture-start',
      actual: { started: false },
      expected: { started: true }
    }
    await start()
    diagnostic = {
      stage: 'mixed',
      check: 'capture-start',
      actual: { started: true },
      expected: { started: true }
    }
    const mixed = await waitFor((view) => {
      const failureCount = view.slots.filter((slot) => slot.code === 'INTERNAL_SERVER_ERROR').length
      const pendingCount = view.slots.filter((slot) => slot.state === 'pending').length
      const limitedCount = view.slots.filter((slot) => slot.code === 'SEARCH_RATE_LIMITED').length
      const regionMask = view.regionMask
      const hasAllRegions = regionMask === 15
      if (!hasAllRegions) {
        diagnostic = {
          stage: 'mixed',
          check: 'mixed-state-ready',
          actual: { regionMask, statusesMatched: false, failureCount, pendingCount, limitedCount },
          expected: {
            regionMask: 15,
            statusesMatched: true,
            failureCount: 2,
            pendingCount: 1,
            limitedCount: 1
          }
        }
        return false
      }
      const statusesMatched = view.slots.every((slot) => slot.statusMatched)
      const hasExpectedFailures = failureCount === 2
      const hasExpectedPending = pendingCount === 1
      const hasExpectedLimited = limitedCount === 1
      const hasExpectedMixed =
        statusesMatched && hasExpectedFailures && hasExpectedPending && hasExpectedLimited
      diagnostic = {
        stage: 'mixed',
        check: 'mixed-state-ready',
        actual: {
          regionMask,
          statusesMatched,
          failureCount,
          pendingCount,
          limitedCount
        },
        expected: {
          regionMask: 15,
          statusesMatched: true,
          failureCount: 2,
          pendingCount: 1,
          limitedCount: 1
        }
      }
      return hasExpectedMixed
    })
    // HTTP 도착 순서를 slot 번호로 가정하지 않고 실제 수용한 상태에서 역할을 찾는다.
    const failures = mixed.slots.flatMap((slot, index) =>
      slot.code === 'INTERNAL_SERVER_ERROR' ? [index] : []
    )
    const pendingSlot = mixed.slots.findIndex((slot) => slot.state === 'pending')
    const limitedSlot = mixed.slots.findIndex((slot) => slot.code === 'SEARCH_RATE_LIMITED')
    const limitedBefore = mixed.slots[limitedSlot]
    const hasInitialRetryWait = hasRetryWait(limitedBefore)
    const hasPositiveWait = hasInitialRetryWait && limitedBefore.retryAfterSeconds > 0
    let isRetryDisabledWhileWaiting = false
    if (hasPositiveWait) {
      const retryDisabled = limitedBefore.retryDisabled === true
      isRetryDisabledWhileWaiting = retryDisabled
    }
    diagnostic = {
      stage: 'mixed',
      check: 'initial-rate-wait',
      actual: {
        hasRetryWait: hasInitialRetryWait,
        hasPositiveWait,
        retryDisabled: isRetryDisabledWhileWaiting
      },
      expected: { hasRetryWait: true, hasPositiveWait: true, retryDisabled: true }
    }
    assert.equal(isRetryDisabledWhileWaiting, true)
    const mixedRequests = search.counts.requests
    search.selectScenario('success')
    const currentRequests = search.counts.requests
    assertScenarioSelectionQuiet({
      currentRequests,
      expectedRequests: mixedRequests,
      recordDiagnostic: (record) => {
        diagnostic = record
      }
    })
    await retry({ slot: failures[0], diagnosticCheck: 'first-retry-click' })
    const firstRetry = await waitFor((view) => {
      const hasSucceeded = view.slots[failures[0]].state === 'success'
      const hasMatchingStatus = hasSucceeded && view.slots[failures[0]].statusMatched
      diagnostic = {
        stage: 'mixed',
        check: 'first-retry-ready',
        actual: {
          succeeded: hasSucceeded,
          statusMatched: hasMatchingStatus
        },
        expected: { succeeded: true, statusMatched: true }
      }
      return hasMatchingStatus
    })
    const hasIndependentSlots = mixed.slots.every((before, index) => {
      const isRetried = index === failures[0]
      const after = firstRetry.slots[index]
      if (isRetried) {
        const hasNewRequest = before.requestId !== after.requestId
        return hasNewRequest
      }
      const hasSameRequest = sameRequest({ before, after })
      const hasUnchangedState = hasSameRequest && before.state === after.state
      return hasUnchangedState
    })
    const independentRetry = hasIndependentSlots && search.counts.requests === mixedRequests + 1
    diagnostic = createIndependentRetryDiagnostic({ independentRetry })
    assert.equal(independentRetry, true)

    enterStage('rate-wait')
    const beforeBlockedUi = await read()
    const blockedSlot = beforeBlockedUi.slots[limitedSlot]
    const hasBlockedWait = hasRetryWait(blockedSlot)
    const hasPositiveBlockedWait = hasBlockedWait && blockedSlot.retryAfterSeconds > 0
    assert.equal(hasPositiveBlockedWait, true)
    {
      const retryDisabled = blockedSlot.retryDisabled === true
      assert.equal(retryDisabled, true)
    }
    const beforeBlocked = search.counts.requests
    await retry({ slot: limitedSlot, allowDisabled: true })
    await read()
    assert.equal(search.counts.requests, beforeBlocked)
    const expired = await waitFor((view) => {
      const hasExpiredWait = view.slots[limitedSlot].retryAfterSeconds === 0
      const isRetryEnabled = hasExpiredWait && view.slots[limitedSlot].retryDisabled === false
      return isRetryEnabled
    })
    const hasObservedWait = hasPositiveWait
    let rateWait = false
    if (hasObservedWait) {
      const hasSameLimitedRequest = sameRequest({
        before: limitedBefore,
        after: expired.slots[limitedSlot]
      })
      if (hasSameLimitedRequest) {
        const hasRetainedRateLimit = expired.slots[limitedSlot].code === 'SEARCH_RATE_LIMITED'
        if (hasRetainedRateLimit) {
          rateWait = expired.slots[limitedSlot].statusMatched
        }
      }
    }
    const rateNoAutoGet = search.counts.requests === beforeBlocked
    const hasWaitedWithoutAutoGet = rateWait && rateNoAutoGet
    assert.equal(hasWaitedWithoutAutoGet, true)
    await retry({ slot: limitedSlot })
    await retry({ slot: failures[1] })
    enterStage('timeout')
    const timedOut = await waitFor((view) => {
      const hasTimedOut = view.slots[pendingSlot].code === 'SEARCH_TIMEOUT'
      const hasMatchingTimeout = hasTimedOut && view.slots[pendingSlot].statusMatched
      return hasMatchingTimeout
    }, 20_000)
    const hasSameTimedOutRequest = sameRequest({
      before: mixed.slots[pendingSlot],
      after: timedOut.slots[pendingSlot]
    })
    const timeout = hasSameTimedOutRequest && timedOut.slots[pendingSlot].retryDisabled === false
    assert.equal(timeout, true)
    await retry({ slot: pendingSlot })
    await waitFor((view) => {
      const hasAllCandidates = view.candidateMask === 15
      const hasSuccessfulView = hasAllCandidates && hasState(view, 'success')
      return hasSuccessfulView
    })

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
      const hasTerminatedWorkers = state.ended && state.terminated === state.workers
      const hasAbortedPendingRequests =
        hasTerminatedWorkers && search.counts.pendingAborts === abortsBeforeLogout + 4
      return hasAbortedPendingRequests
    })
    const stopped = await observe()
    const stoppedUi = await read()
    const hasStoppedStreams = stopped.ended && stopped.stops === stopped.streams
    let pendingCleanup = false
    if (hasStoppedStreams) {
      const hasClearedVideos = stopped.clearedVideos === stopped.streams
      if (hasClearedVideos) {
        const hasRemovedCapture = stoppedUi.captureId === null
        if (hasRemovedCapture) {
          const hasRemovedRegions = stoppedUi.regionMask === 0
          if (hasRemovedRegions) {
            pendingCleanup = stoppedUi.ocrMask === 0
          }
        }
      }
    }
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
    const hasNoCapture = blank.captureId === null
    let relogin = false
    if (hasNoCapture) {
      const hasNoSelection = !blank.sourceSelected
      if (hasNoSelection) {
        const hasDisabledStart = blank.startDisabled === true
        if (hasDisabledStart) {
          const hasIdleView = hasState(blank, 'idle')
          if (hasIdleView) {
            const hasUnchangedStreams = afterLogin.streams === stopped.streams
            if (hasUnchangedStreams) {
              const hasUnchangedWorkers = afterLogin.workers === stopped.workers
              if (hasUnchangedWorkers) {
                relogin = search.counts.requests === requestsBeforeQuiet
              }
            }
          }
        }
      }
    }
    assert.equal(relogin, true)
    search.selectScenario('success')
    await selectSyntheticSource()
    const restarted = await start()
    const hasRestartedCapture = restarted.captureId != null
    const newCapture = hasRestartedCapture && restarted.captureId !== beforeLogout.captureId
    const complete = await waitFor((view) => {
      const hasAllCandidates = view.candidateMask === 15
      const hasSuccessfulView = hasAllCandidates && hasState(view, 'success')
      return hasSuccessfulView
    })
    assert.equal(newCapture, true)
    enterStage('layout')
    await inspectLayouts(window, read)
    enterStage('final-cleanup')
    await stop()
    await click('이 기기 로그아웃')
    await until(() => hasText('Google로 계속하기'))
    const final = await observe()
    const hasTerminatedWorkers = final.ended && final.terminated === final.workers
    let hasStoppedAllStreams = false
    if (hasTerminatedWorkers) {
      const hasStoppedStreams = final.stops === final.streams
      hasStoppedAllStreams = hasStoppedStreams
    }
    assert.equal(hasStoppedAllStreams, true)
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
  } catch (error) {
    const isMixedStage = stage === 'mixed'
    if (isMixedStage) {
      rethrowMixedSearchFailure({ error, diagnostic })
    }
    console.error(`Capture fixture search stage FAIL: ${stage}`)
    throw error
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
        const isDark = view.dark
        const expectsDarkTheme = theme === 'dark'
        const hasThemeMismatch = isDark !== expectsDarkTheme
        themeMismatchCount += Number(hasThemeMismatch)
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
