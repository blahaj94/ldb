import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserWindow } from 'electron'
import type { AuthCoordinator } from '../../src/backend/auth/types'

export type Observation = {
  requests: number
  streams: number
  stops: number
  workers: number
  terminated: number
  clearedVideos: number
  ended: boolean
  width: number
  height: number
  frameWidth: number
  frameHeight: number
  allSlotsPresent: boolean
  recognitionRequests: number
}

export async function until(condition: () => Promise<boolean>, deadlineMs = 10_000): Promise<void> {
  const deadline = performance.now() + deadlineMs
  while (true) {
    const hasTime = performance.now() < deadline
    if (!hasTime) throw new Error('Capture fixture observation deadline exceeded')
    if (await condition()) return
    await delay(50)
  }
}

export function createCaptureActions({
  window,
  coordinator,
  completeLogin
}: {
  window: BrowserWindow
  coordinator: AuthCoordinator
  completeLogin: () => Promise<void>
}): {
  evaluate: (source: string, userGesture?: boolean) => Promise<unknown>
  hasText: (text: string) => Promise<boolean>
  observe: () => Promise<Observation>
  click: (label: string) => Promise<void>
  enterHome: () => Promise<void>
  selectSyntheticSource: () => Promise<void>
} {
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

  async function selectSyntheticSource(): Promise<void> {
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
  }
  return { evaluate, hasText, observe, click, enterHome, selectSyntheticSource }
}
