import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserWindow } from 'electron'
import type { AuthCoordinator } from '../../src/backend/auth/types'
import { installObservation } from './observe'
import type { CaptureObservation } from './capture-observation'
import { createCaptureActions, until, type Observation } from './actions'

const sandboxInspectionSource = `(() => {
  const hasNoElectron = typeof window.electron === "undefined";
  const hasNoRequire = hasNoElectron && typeof window.require === "undefined";
  return hasNoRequire;
})()`

const sourceAbsenceInspection = `(() => {
  const hasNoSourceSelect = document.querySelector("select") === null;
  return hasNoSourceSelect;
})()`

const disabledStartInspection = `(() => {
  const hasDisabledStart = [...document.querySelectorAll('button')].some(button => {
    const isStart = button.textContent === 'Start';
    const isDisabledStart = isStart && button.disabled;
    return isDisabledStart;
  });
  return hasDisabledStart;
})()`

const unselectedMediaRequest = `navigator.mediaDevices
  .getDisplayMedia({ video: true, audio: false })
  .then(
  stream => {
    stream.getTracks()
      .forEach(track => track.stop());
    return false;
  },
  () => true
)`

function createDisplayInspectionSource(): string {
  const displayInspectionSource = `(() => {
      const lines = document
        .querySelector('pre')?.textContent
        ?.split('\\n') ?? [];
      let matchedSlots = 0;
      for (let slot = 0; slot < 4; slot += 1) {
        const isExpectedDisplay = lines.includes('Slot ' + (slot + 1) + ': ALICE');
        if (isExpectedDisplay) {
          matchedSlots |= 1 << slot;
        }
      }
      return matchedSlots;
    })()`
  return displayInspectionSource
}

export async function smoke(
  window: BrowserWindow,
  coordinator: AuthCoordinator,
  completeLogin: () => Promise<void>,
  mainObservation: CaptureObservation
): Promise<void> {
  const { evaluate, hasText, observe, click, enterHome, selectSyntheticSource } =
    createCaptureActions({ window, coordinator, completeLogin })

  console.log('Capture fixture step: auth-and-sandbox')
  await until(() => hasText('Google로 계속하기'))
  assert.equal(await evaluate(sandboxInspectionSource), true)
  assert.equal(await evaluate(sourceAbsenceInspection), true)
  assert.equal(await evaluate(installObservation), true)
  await enterHome()

  console.log('Capture fixture step: synthetic-source-selection')
  await selectSyntheticSource()
  assert.equal((await observe()).requests, 0)

  console.log('Capture fixture step: real-media-and-ocr')
  await click('Start')
  await until(async () => {
    const state = await observe()
    const isMediaReady = state.streams === 1
    return isMediaReady
  }, 20_000)
  console.log('Capture fixture actual stream acquired')
  await until(() => hasText('Capture ready at 1920×1080.'), 30_000)
  console.log('Capture fixture actual OCR worker ready')
  let displayMatchedSlots = 0
  await until(async () => {
    const displayInspectionSource = createDisplayInspectionSource()
    displayMatchedSlots = (await evaluate(displayInspectionSource)) as number
    const hasAllDisplays = displayMatchedSlots === 0b1111
    const hasAllNotifications = mainObservation.nicknameMatchedSlots === 0b1111
    const hasAllSyntheticMatches = hasAllDisplays && hasAllNotifications
    return hasAllSyntheticMatches
  }, 30_000)
  const active = await observe()
  assert.equal(mainObservation.displayRequests, 1)
  assert.equal(mainObservation.displayAllowed, 1)
  const isSafeWidth = Number.isSafeInteger(active.width)
  const hasPositiveWidth = isSafeWidth && active.width > 0
  assert.ok(hasPositiveWidth)
  const isSafeHeight = Number.isSafeInteger(active.height)
  const hasPositiveHeight = isSafeHeight && active.height > 0
  assert.ok(hasPositiveHeight)
  // 제품이 지원하는 기존 video frame geometry를 확인한다. Native track 크기는 별도 관측값이다.
  assert.equal(active.frameWidth, 1920)
  assert.equal(active.frameHeight, 1080)
  assert.equal(active.allSlotsPresent, true)
  console.log(
    `Capture fixture synthetic matches: ${JSON.stringify({ displayMatchedSlots, nicknameMatchedSlots: mainObservation.nicknameMatchedSlots })}`
  )
  console.log(
    `Capture fixture geometry: ${JSON.stringify({ trackWidth: active.width, trackHeight: active.height, frameWidth: active.frameWidth, frameHeight: active.frameHeight, allSlotsPresent: active.allSlotsPresent })}`
  )
  assert.equal(active.workers, 1)
  assert.equal(active.terminated, 0)
  assert.equal(active.ended, false)
  console.log('Capture fixture real media/OCR PASS')

  console.log('Capture fixture step: logout-cleanup')
  await click('이 기기 로그아웃')
  await until(() => hasText('Google로 계속하기'))
  await until(async () => {
    const state = await observe()
    const hasOneStop = state.stops === 1
    const hasStopped = hasOneStop && state.ended
    const hasTerminated = state.terminated === 1
    const hasCompletedCleanup = hasStopped && hasTerminated
    return hasCompletedCleanup
  })
  assert.equal((await observe()).clearedVideos, 1)
  assert.equal(await hasText('Slot 1:'), false)
  assert.equal(await evaluate(sourceAbsenceInspection), true)

  const stopped = await observe()
  const stoppedInvokes = mainObservation.nicknameInvokes
  await delay(3_200)
  assert.equal((await observe()).recognitionRequests, stopped.recognitionRequests)
  assert.equal(mainObservation.nicknameInvokes, stoppedInvokes)
  console.log('Capture fixture stopped OCR/IPC quiet interval PASS')

  console.log('Capture fixture step: relogin-requires-selection-and-start')
  await enterHome()
  assert.equal(await evaluate('document.querySelector("select").value'), '')
  assert.equal(await evaluate(disabledStartInspection), true)
  assert.equal((await observe()).requests, 1)
  assert.equal((await observe()).workers, 1)
  assert.equal(await hasText('Slot 1:'), false)
  // Source를 다시 고르지 않은 새 session은 실제 getDisplayMedia도 거절한다.
  assert.equal(await evaluate(unselectedMediaRequest, true), true)
  assert.equal((await observe()).streams, 1)
  assert.equal(mainObservation.displayRequests, 2)
  assert.equal(mainObservation.displayAllowed, 1)
  await click('이 기기 로그아웃')
  await until(() => hasText('Google로 계속하기'))
}

export async function smokeStandaloneOcr(window: BrowserWindow): Promise<void> {
  console.log('Capture fixture step: standalone-real-ocr')
  const evaluate = (source: string): Promise<unknown> =>
    window.webContents.executeJavaScript(source)
  assert.equal(await evaluate(installObservation), true)
  assert.equal(await evaluate(sandboxInspectionSource), true)
  const result = await evaluate('window.runFixtureOcr()')
  assert.deepEqual(result, { matched: true, terminated: true })
  const observation = (await evaluate('window.captureObservation()')) as Observation
  assert.equal(observation.workers, 1)
  assert.equal(observation.terminated, 1)
  assert.equal(observation.streams, 0)
  assert.equal(observation.requests, 0)
}

export { smokeCharacterSearch } from './search-smoke'
