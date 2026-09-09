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
    if (!hasTime) {
      throw new Error('Capture fixture observation deadline exceeded')
    }
    const isReady = await condition()
    if (isReady) {
      return
    }
    await delay(50)
  }
}

function createClickSource(label: string): string {
  const source = `(() => {
      const button = [...document.querySelectorAll('button')].find(item => {
        const hasLabel = item.textContent === ${JSON.stringify(label)};
        return hasLabel;
      });
      const hasButton = button != null;
      const canClick = hasButton && !button.disabled;
      if (!canClick) {
        return false;
      }
      button.click();
      return true;
    })()`
  return source
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
    const source = createClickSource(label)
    assert.equal(await evaluate(source, true), true)
  }
  async function enterHome(): Promise<void> {
    await until(() => hasText('Google로 계속하기'))
    await click('Google로 계속하기')
    await until(async () => {
      const isWaitingBrowser = coordinator.getSnapshot().phase === 'waitingBrowser'
      return isWaitingBrowser
    })
    await completeLogin()
    await until(() => hasText('시작하기'))
    assert.equal(await evaluate('document.querySelector("select") === null'), true)
    await click('시작하기')
    await until(() => hasText('Select a window'))
  }

  async function selectSyntheticSource(): Promise<void> {
    const syntheticSourceCheck = `(() => {
    const select = document.querySelector('select');
    const hasSelect = select != null;
    const source = hasSelect ? [...select.options].find(option => {
      const isSyntheticSource = option.textContent === 'LDB Synthetic Capture Source';
      return isSyntheticSource;
    }) : null;
    const hasSource = source != null;
    return hasSource;
  })()`
    await until(async () => (await evaluate(syntheticSourceCheck)) as boolean)

    const syntheticSourceSelection = `(() => {
    const select = document.querySelector('select');
    const source = [...select.options].find(option => {
      const isSyntheticSource = option.textContent === 'LDB Synthetic Capture Source';
      return isSyntheticSource;
    });
    select.value = source.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`
    assert.equal(await evaluate(syntheticSourceSelection), true)
    const startButtonCheck = `(() => {
      const hasEnabledStart = [...document.querySelectorAll('button')].some(button => {
        const isStart = button.textContent === 'Start';
        const canStart = isStart && !button.disabled;
        return canStart;
      });
      return hasEnabledStart;
    })()`
    await until(async () => (await evaluate(startButtonCheck)) as boolean)
  }
  return { evaluate, hasText, observe, click, enterHome, selectSyntheticSource }
}
