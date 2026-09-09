import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserWindow } from 'electron'
import type { AuthCoordinator, AuthSnapshot } from '../../src/backend/auth/types'
import { canaries, syntheticCode, createFixtureEffects } from './effects'

function createClickSource(label: string): string {
  const source = `(() => {
      const button = [...document.querySelectorAll('button')].find(button => {
        const hasLabel = button.textContent === ${JSON.stringify(label)};
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

async function until(condition: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000
  while (true) {
    const hasTime = performance.now() < deadline
    if (!hasTime) {
      break
    }
    const isReady = await condition()
    if (isReady) {
      return
    }
    await delay(20)
  }
  throw new Error('Fixture observation deadline exceeded')
}

export async function smoke(
  window: BrowserWindow,
  coordinator: AuthCoordinator,
  effects: ReturnType<typeof createFixtureEffects>
): Promise<void> {
  const evaluate = (source: string): Promise<unknown> =>
    window.webContents.executeJavaScript(source)
  async function click(label: string): Promise<void> {
    const source = createClickSource(label)
    const clicked = await evaluate(source)
    assert.equal(clicked, true)
  }
  async function textIncludes(text: string): Promise<boolean> {
    return (await evaluate(
      `document.body.textContent.includes(${JSON.stringify(text)})`
    )) as boolean
  }
  const state = async (): Promise<AuthSnapshot> =>
    (await evaluate('window.auth.getAuthState()')) as AuthSnapshot
  const noCanary = (value: unknown): void => {
    const encoded = JSON.stringify(value)
    for (const canary of canaries) {
      const hasCanary = encoded.includes(canary)
      assert.equal(hasCanary, false)
    }
  }

  console.log('Auth bridge fixture step: initial')
  await until(() => textIncludes('Google로 계속하기'))
  assert.deepEqual(await evaluate('Object.keys(window.auth).sort()'), [
    'beginLogin',
    'cancelLogin',
    'getAuthState',
    'logout',
    'onAuthStateChanged',
    'retryAuth'
  ])
  const sandboxInspectionSource = `(() => {
    const hasNoElectronApi = typeof window.electron === 'undefined';
    const hasNoPrivilegedGlobals = hasNoElectronApi && typeof window.require === 'undefined';
    return hasNoPrivilegedGlobals;
  })()`
  assert.equal(await evaluate(sandboxInspectionSource), true)
  assert.equal((await state()).phase, 'signedOut')
  await evaluate(
    'window.fixtureEvents = []; window.fixtureOff = window.auth.onAuthStateChanged((...args) => window.fixtureEvents.push(args)); true'
  )
  console.log('Auth bridge fixture step: begin-cancel')
  await click('Google로 계속하기')
  await until(async () => {
    const isWaitingBrowser = (await state()).phase === 'waitingBrowser'
    return isWaitingBrowser
  })
  await until(() => textIncludes('로그인 취소'))
  const waiting = await state()
  noCanary(waiting)
  const events = (await evaluate('window.fixtureEvents')) as AuthSnapshot[][]
  const hasInitialAuthEvents = events.length >= 2
  assert.ok(hasInitialAuthEvents)
  for (const args of events) {
    assert.equal(args.length, 1)
    noCanary(args)
  }
  await click('로그인 취소')
  await until(async () => {
    const isSignedOut = (await state()).phase === 'signedOut'
    return isSignedOut
  })
  await until(() => textIncludes('로그인을 취소했습니다'))
  await evaluate('window.fixtureOff(); window.fixtureEvents = []')
  console.log('Auth bridge fixture step: unsubscribe-reload')
  await click('Discord로 계속하기')
  await until(async () => {
    const isWaitingBrowser = (await state()).phase === 'waitingBrowser'
    return isWaitingBrowser
  })
  assert.deepEqual(await evaluate('window.fixtureEvents'), [])
  const beforeReload = await state()
  await new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve())
    window.webContents.reload()
  })
  await until(() => textIncludes('로그인 취소'))
  assert.equal((await state()).login?.attemptId, beforeReload.login?.attemptId)

  console.log('Auth bridge fixture step: exchange-commit')
  effects.holdCommit()
  const exchange = coordinator.handleReturnUrl(
    `${effects.dependencies.returnTarget}?code=${syntheticCode}`
  )
  await until(async () => {
    const hasStartedCommit = effects.counts.commit === 1
    return hasStartedCommit
  })
  assert.equal((await state()).phase, 'exchanging')
  assert.equal(await textIncludes('중립모험가'), false)
  effects.releaseCommit()
  await exchange
  await until(() => textIncludes('시작하기'))
  const signedIn = await state()
  assert.equal(signedIn.phase, 'signedIn')
  assert.equal(signedIn.entry, 'welcome')
  noCanary(signedIn)
  console.log('Auth bridge fixture step: welcome-logout')
  await click('시작하기')
  await until(() => textIncludes('화면 캡처'))
  await click('이 기기 로그아웃')
  await until(() => textIncludes('Google로 계속하기'))
  assert.equal((await state()).phase, 'signedOut')
  assert.deepEqual(effects.counts, { browser: 2, exchange: 1, logout: 1, commit: 1 })
}
