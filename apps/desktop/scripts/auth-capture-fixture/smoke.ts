import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserWindow } from 'electron'
import type { AuthCoordinator } from '../../src/backend/auth/types'
import { installObservation } from './observe'

type Observation = {
  requests: number
  streams: number
  stops: number
  workers: number
  terminated: number
  clearedVideos: number
  ended: boolean
}

async function until(condition: () => Promise<boolean>, deadlineMs = 10_000): Promise<void> {
  const deadline = performance.now() + deadlineMs
  while (true) {
    const hasTime = performance.now() < deadline
    if (!hasTime) throw new Error('Capture fixture observation deadline exceeded')
    if (await condition()) return
    await delay(50)
  }
}

export async function smoke(
  window: BrowserWindow,
  coordinator: AuthCoordinator,
  completeLogin: () => Promise<void>
): Promise<void> {
  const evaluate = (source: string, userGesture = false): Promise<unknown> =>
    window.webContents.executeJavaScript(source, userGesture)
  const hasText = async (text: string): Promise<boolean> =>
    (await evaluate(`document.body.textContent.includes(${JSON.stringify(text)})`)) as boolean
  const observe = async (): Promise<Observation> =>
    (await evaluate('window.captureObservation()')) as Observation
  const click = async (label: string): Promise<void> => {
    assert.equal(
      await evaluate(
        `(() => {
      const button = [...document.querySelectorAll('button')].find(item => item.textContent === ${JSON.stringify(label)});
      const hasButton = button != null;
      const canClick = hasButton && !button.disabled;
      if (!canClick) return false;
      button.click(); return true;
    })()`,
        true
      ),
      true
    )
  }
  async function enterHome(): Promise<void> {
    await until(() => hasText('Google로 계속하기'))
    await click('Google로 계속하기')
    await until(async () => coordinator.getSnapshot().phase === 'waitingBrowser')
    await completeLogin()
    await until(() => hasText('시작하기'))
    assert.equal(await evaluate('document.querySelector("select") === null'), true)
    await click('시작하기')
    await until(() => hasText('Select a window'))
  }

  console.log('Capture fixture step: auth-and-sandbox')
  await until(() => hasText('Google로 계속하기'))
  assert.equal(
    await evaluate(
      'typeof window.electron === "undefined" && typeof window.require === "undefined"'
    ),
    true
  )
  assert.equal(await evaluate('document.querySelector("select") === null'), true)
  assert.equal(await evaluate(installObservation), true)
  await enterHome()

  console.log('Capture fixture step: synthetic-source-selection')
  await until(
    async () =>
      (await evaluate(`(() => {
    const select = document.querySelector('select');
    const hasSelect = select != null;
    const source = hasSelect ? [...select.options].find(option => option.textContent === 'LDB Synthetic Capture Source') : null;
    return source != null;
  })()`)) as boolean
  )
  assert.equal(
    await evaluate(`(() => {
    const select = document.querySelector('select');
    const source = [...select.options].find(option => option.textContent === 'LDB Synthetic Capture Source');
    select.value = source.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`),
    true
  )
  await until(
    async () =>
      (await evaluate(
        `[...document.querySelectorAll('button')].some(button => button.textContent === 'Start' && !button.disabled)`
      )) as boolean
  )
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
  await until(() => hasText('Slot 1: ALICE'), 30_000)
  const active = await observe()
  assert.equal(active.workers, 1)
  assert.equal(active.terminated, 0)
  assert.equal(active.ended, false)
  console.log('Capture fixture real media/OCR PASS')

  console.log('Capture fixture step: logout-cleanup')
  await click('이 기기 로그아웃')
  await until(() => hasText('Google로 계속하기'))
  await until(async () => {
    const state = await observe()
    const hasStopped = state.stops === 1 && state.ended
    const hasTerminated = state.terminated === 1
    return hasStopped && hasTerminated
  })
  assert.equal((await observe()).clearedVideos, 1)
  assert.equal(await hasText('Slot 1:'), false)
  assert.equal(await evaluate('document.querySelector("select") === null'), true)

  console.log('Capture fixture step: relogin-requires-selection-and-start')
  await enterHome()
  assert.equal(await evaluate('document.querySelector("select").value'), '')
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('button')].some(button => button.textContent === 'Start' && button.disabled)`
    ),
    true
  )
  assert.equal((await observe()).requests, 1)
  assert.equal((await observe()).workers, 1)
  assert.equal(await hasText('Slot 1:'), false)
  // Source를 다시 고르지 않은 새 session은 실제 getDisplayMedia도 거절한다.
  assert.equal(
    await evaluate(
      `navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then(stream => { stream.getTracks().forEach(track => track.stop()); return false; }, () => true)`,
      true
    ),
    true
  )
  assert.equal((await observe()).streams, 1)
  await click('이 기기 로그아웃')
  await until(() => hasText('Google로 계속하기'))
}

export async function smokeStandaloneOcr(window: BrowserWindow): Promise<void> {
  console.log('Capture fixture step: standalone-real-ocr')
  const evaluate = (source: string): Promise<unknown> =>
    window.webContents.executeJavaScript(source)
  assert.equal(await evaluate(installObservation), true)
  assert.equal(
    await evaluate(
      'typeof window.electron === "undefined" && typeof window.require === "undefined"'
    ),
    true
  )
  const result = await evaluate('window.runFixtureOcr()')
  assert.deepEqual(result, { matched: true, terminated: true })
  const observation = (await evaluate('window.captureObservation()')) as Observation
  assert.equal(observation.workers, 1)
  assert.equal(observation.terminated, 1)
  assert.equal(observation.streams, 0)
  assert.equal(observation.requests, 0)
}
