import { spawn } from 'node:child_process'
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const entry = fileURLToPath(new URL('../out/auth-capture-fixture/main/main.cjs', import.meta.url))

/** @returns {void} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch {
    /* 종료 여부는 별도로 확인한다. */
  }
}

// credential-store-native.mjs와 같은 POSIX owned-group 종료 확인 순서다.
/** @returns {Promise<boolean>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
async function waitForGroupExit(pid, milliseconds) {
  const deadline = Date.now() + milliseconds
  while (true) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      const isAbsent = error.code === 'ESRCH'
      if (isAbsent) {
        return true
      }
      return false
    }
    const hasExpired = Date.now() >= deadline
    if (hasExpired) {
      return false
    }
    await delay(50)
  }
}

/** @returns {Promise<boolean>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
async function finishGroup(pid) {
  let stopped = await waitForGroupExit(pid, 500)
  if (stopped) {
    return true
  }
  signalGroup(pid, 'SIGTERM')
  stopped = await waitForGroupExit(pid, 2_000)
  if (stopped) {
    return true
  }
  signalGroup(pid, 'SIGKILL')
  return waitForGroupExit(pid, 1_000)
}

/** @returns {Promise<boolean>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
async function removeProfile(profile) {
  try {
    await rm(profile, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    return false
  }
  try {
    await lstat(profile)
  } catch (error) {
    const isAbsent = error.code === 'ENOENT'
    return isAbsent
  }
  return false
}

/** @returns {Promise<number>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
export async function runCaptureFixture(args = []) {
  const isInteractive = args.length === 0
  const hasOneMode = args.length === 1
  const isSmoke = hasOneMode && args[0] === '--smoke'
  const isSearchSmoke = hasOneMode && args[0] === '--search-smoke'
  const isOcr = hasOneMode && args[0] === '--ocr'
  const isDenyMedia = hasOneMode && args[0] === '--deny-media'
  const hasValidMode = isInteractive || isSmoke || isOcr || isDenyMedia || isSearchSmoke
  const hasPosixGroups = process.platform !== 'win32'
  if (!hasValidMode || !hasPosixGroups) {
    console.error('Capture fixture launcher configuration FAIL')
    return 1
  }
  let profile
  let child
  let interrupted = false
  let finalizing = false
  let exitCode = 1
  let deadline
  let forcedKill
  /** @returns {void} */
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
  function interrupt() {
    if (interrupted) {
      return
    }
    interrupted = true
    if (finalizing) {
      return
    }
    const hasPid = child?.pid != null
    if (!hasPid) {
      return
    }
    signalGroup(child.pid, 'SIGTERM')
    forcedKill = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), 2_000)
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    profile = await mkdtemp(join(tmpdir(), 'ldb-auth-capture-fixture-'))
    if (interrupted) {
      return 1
    }
    await writeFile(
      join(profile, 'owner.json'),
      JSON.stringify({ kind: 'auth-capture-fixture', launcherPid: process.pid }),
      { mode: 0o600 }
    )
    if (interrupted) {
      return 1
    }
    const environment = {
      ...process.env,
      LDB_AUTH_CAPTURE_PROFILE: profile,
      LDB_AUTH_CAPTURE_LAUNCHER_PID: String(process.pid)
    }
    delete environment.ELECTRON_RUN_AS_NODE
    child = spawn(require('electron'), [entry, ...args], {
      env: environment,
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit']
    })
    if (!isInteractive) {
      deadline = setTimeout(interrupt, isSearchSmoke ? 210_000 : 120_000)
    }
    const code = await new Promise((accept, reject) => {
      child.once('error', () => reject(new Error('Capture fixture child could not start')))
      child.once('close', accept)
    })
    const succeeded = code === 0 && !interrupted
    exitCode = succeeded ? 0 : 1
  } catch {
    console.error('Capture fixture launcher execution FAIL')
  } finally {
    finalizing = true
    clearTimeout(deadline)
    clearTimeout(forcedKill)
    const hasPid = child?.pid != null
    const groupStopped = !hasPid || (await finishGroup(child.pid))
    const hasProfile = profile != null
    const profileRemoved = hasProfile && groupStopped && (await removeProfile(profile))
    const cleanupConfirmed = groupStopped && profileRemoved
    if (cleanupConfirmed) {
      console.log('Capture fixture cleanup PASS')
    } else {
      console.error('Capture fixture cleanup FAIL')
      exitCode = 1
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
  return interrupted ? 1 : exitCode
}

const invokedPath = process.argv[1]
const hasInvokedPath = invokedPath != null
const isDirectInvocation =
  hasInvokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isDirectInvocation) {
  process.exitCode = await runCaptureFixture(process.argv.slice(2))
}
