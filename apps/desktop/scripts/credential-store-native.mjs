import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { builtinModules, createRequire } from 'node:module'
import { lstat, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const appDirectory = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const prepareOnly = process.argv.includes('--prepare-only')
const failAfterWrite = process.argv.includes('--fail-after-write')
const isMacOs = process.platform === 'darwin'
const canRun = prepareOnly || isMacOs
if (!canRun) throw new Error('Native credential validation requires macOS.')
const ownedGroups = new Set()
let interrupted = false
/** @returns {void} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
function interruptRun() {
  interrupted = true
  for (const pid of ownedGroups) {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      /* 종료 확인은 execute에서 수행한다. */
    }
  }
}
process.once('SIGINT', interruptRun)
process.once('SIGTERM', interruptRun)

/** @returns {Promise<boolean>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
async function waitForGroupExit(pid, milliseconds) {
  const deadline = Date.now() + milliseconds
  while (true) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      const hasExited = error.code === 'ESRCH'
      if (hasExited) {
        ownedGroups.delete(pid)
        return true
      }
      throw new Error('Owned process group exit could not be confirmed.')
    }
    const hasExpired = Date.now() >= deadline
    if (hasExpired) return false
    await delay(50)
  }
}

/** @returns {Promise<void>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
async function confirmPathAbsent(path) {
  try {
    await lstat(path)
  } catch (error) {
    const isAbsent = error.code === 'ENOENT'
    if (isAbsent) return
  }
  throw new Error('Owned path cleanup could not be confirmed.')
}

/** @returns {Promise<{code: number | null, stdout: string, stderr: string}>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
function execute(command, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    })
    const hasPid = child.pid != null
    if (hasPid) ownedGroups.add(child.pid)
    let stdout = ''
    let stderr = ''
    let forcedKill
    let timedOut = false
    let outputExceeded = false
    /** @returns {void} */
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
    function stopGroup(signal) {
      const hasPid = child.pid != null
      if (!hasPid) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        /* 종료 여부는 waitForGroupExit에서 별도로 확인한다. */
      }
    }
    const timeout = setTimeout(() => {
      timedOut = true
      stopGroup('SIGTERM')
      forcedKill = setTimeout(() => stopGroup('SIGKILL'), 2_000)
    }, 30_000)
    /** @returns {void} */
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
    function capture(chunk, standardOutput) {
      const isWithinLimit = stdout.length + stderr.length + chunk.length <= 65_536
      if (!isWithinLimit) {
        outputExceeded = true
        stopGroup('SIGKILL')
        return
      }
      if (standardOutput) stdout += chunk.toString()
      else stderr += chunk.toString()
    }
    child.stdout.on('data', (chunk) => capture(chunk, true))
    child.stderr.on('data', (chunk) => capture(chunk, false))
    child.on('error', () => {
      clearTimeout(timeout)
      clearTimeout(forcedKill)
      reject(new Error('Native credential command could not start.'))
    })
    child.on('close', async (code) => {
      clearTimeout(timeout)
      clearTimeout(forcedKill)
      try {
        if (hasPid) {
          let stopped = await waitForGroupExit(child.pid, 500)
          if (!stopped) {
            stopGroup('SIGTERM')
            stopped = await waitForGroupExit(child.pid, 2_000)
          }
          if (!stopped) {
            stopGroup('SIGKILL')
            stopped = await waitForGroupExit(child.pid, 1_000)
          }
          if (!stopped) throw new Error('Owned process group remains active.')
        }
      } catch {
        reject(new Error('Owned process group cleanup was not confirmed.'))
        return
      }
      if (timedOut) {
        reject(new Error('Native credential command timed out; no prompt approval was attempted.'))
      } else if (outputExceeded) {
        reject(new Error('Native credential output limit exceeded.'))
      } else {
        resolve({ code, stdout, stderr })
      }
    })
  })
}

/** @returns {Promise<string>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
async function defaultKeychain() {
  const result = await execute('/usr/bin/security', ['default-keychain', '-d', 'user'])
  const succeeded = result.code === 0
  if (!succeeded) throw new Error('Default Keychain metadata unavailable.')
  return JSON.parse(result.stdout.trim())
}

/** @returns {Promise<boolean>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
async function itemExists(appName, keychain) {
  const args = ['find-generic-password', '-s', `${appName} Safe Storage`, '-a', appName]
  const hasKeychain = keychain != null
  if (hasKeychain) args.push(keychain)
  // -g/-w를 사용하지 않는다. Metadata 결과는 capture하고 외부에 출력하지 않는다.
  const result = await execute('/usr/bin/security', args)
  const wasFound = result.code === 0
  const wasAbsent = result.code === 44
  const isRecognizedResult = wasFound || wasAbsent
  if (!isRecognizedResult) throw new Error('Keychain item metadata could not be checked.')
  return wasFound
}

/** @returns {Promise<void>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
async function removeOwnedItem(appName, keychain) {
  const exists = await itemExists(appName, keychain)
  let wasDeleted = !exists
  if (exists) {
    const result = await execute('/usr/bin/security', [
      'delete-generic-password',
      '-s',
      `${appName} Safe Storage`,
      '-a',
      appName,
      keychain
    ])
    wasDeleted = result.code === 0
  }
  const stillExists = await itemExists(appName, keychain)
  const existsInSearchList = await itemExists(appName)
  const isCleanupConfirmed = wasDeleted && !stillExists && !existsInSearchList
  if (!isCleanupConfirmed) throw new Error('Owned Keychain item cleanup was not confirmed.')
}

const bundleParent = join(appDirectory, 'node_modules', '.tmp')
let bundleDirectory
let profileRoot
let keychain
let appName
let mayOwnItem = false
let failure
let cleanupConfirmed = false
let defaultChanged = false
let failedPhase = 'prepare'
let profileRemoved = false
let bundleRemoved = false
let injectedFailure = false
const phaseResults = []

/** @returns {Promise<void>} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
async function cleanupOwnedProfile() {
  const allGroupsStopped = ownedGroups.size === 0
  if (!allGroupsStopped) throw new Error('Owned process group cleanup is incomplete.')
  if (mayOwnItem) {
    await removeOwnedItem(appName, keychain)
    const stillHasSameDefault = (await defaultKeychain()) === keychain
    const hasStableDefault = stillHasSameDefault && !defaultChanged
    if (!hasStableDefault) throw new Error('Keychain identity cleanup is uncertain.')
  }
  const hasProfileRoot = profileRoot != null
  if (hasProfileRoot) {
    await rm(profileRoot, { recursive: true, force: true })
    await confirmPathAbsent(profileRoot)
  }
}

try {
  await mkdir(bundleParent, { recursive: true })
  bundleDirectory = await mkdtemp(join(bundleParent, 'credential-native-127-'))
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: bundleDirectory,
      emptyOutDir: true,
      lib: {
        entry: join(appDirectory, 'scripts', 'credential-store-native', 'main.ts'),
        formats: ['cjs'],
        fileName: () => 'main.cjs'
      },
      rollupOptions: {
        external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)]
      },
      minify: false
    }
  })
  if (interrupted) throw new Error('Native credential validation was interrupted.')
  if (!prepareOnly) {
    appName = `LDB-Credential-Test-${randomUUID()}`
    keychain = await defaultKeychain()
    const existsInSearchList = await itemExists(appName)
    const existsInDefault = await itemExists(appName, keychain)
    const identityAlreadyExists = existsInSearchList || existsInDefault
    if (identityAlreadyExists) throw new Error('Test identity already exists; nothing was changed.')
    profileRoot = await mkdtemp(join(tmpdir(), 'ldb-credential-native-127-'))
    await writeFile(join(profileRoot, 'owner.json'), JSON.stringify({ appName, keychain }), {
      mode: 0o600
    })
    const profile = join(profileRoot, 'profile')
    await mkdir(profile, { mode: 0o700 })
    for (const phase of ['write', 'restart', 'mark', 'recover']) {
      if (interrupted) throw new Error('Native credential validation was interrupted.')
      failedPhase = phase
      const hasSameDefault = (await defaultKeychain()) === keychain
      if (!hasSameDefault) {
        defaultChanged = true
        throw new Error('Default Keychain changed; native validation stopped.')
      }
      mayOwnItem = true
      const childEnvironment = {
        ...process.env,
        LDB_CREDENTIAL_NATIVE_NAME: appName,
        LDB_CREDENTIAL_NATIVE_PROFILE: profile,
        LDB_CREDENTIAL_NATIVE_PHASE: phase
      }
      delete childEnvironment.ELECTRON_RUN_AS_NODE
      const result = await execute(
        require('electron'),
        [join(bundleDirectory, 'main.cjs')],
        childEnvironment
      )
      const stillHasSameDefault = (await defaultKeychain()) === keychain
      if (!stillHasSameDefault) {
        defaultChanged = true
        throw new Error('Default Keychain changed; native validation stopped.')
      }
      const line = result.stdout.split('\n').find((line) => {
        const hasResultPrefix = line.startsWith('LDB_CREDENTIAL_NATIVE:')
        return hasResultPrefix
      })
      const hasResult = line != null
      const parsed = hasResult ? JSON.parse(line.slice('LDB_CREDENTIAL_NATIVE:'.length)) : null
      const hasSuccessfulExit = result.code === 0
      const hasSuccessfulResult = parsed?.ok === true
      const hasExpectedPhase = parsed?.phase === phase
      const hasDecryptCount = Number.isSafeInteger(parsed?.decryptCalls) && parsed.decryptCalls >= 0
      const hasAvailabilityCount =
        Number.isSafeInteger(parsed?.encryptionAvailabilityCalls) &&
        parsed.encryptionAvailabilityCalls >= 0
      const succeeded =
        hasSuccessfulExit &&
        hasSuccessfulResult &&
        hasExpectedPhase &&
        hasDecryptCount &&
        hasAvailabilityCount
      if (!succeeded)
        throw new Error('Native credential phase failed; raw diagnostics were withheld.')
      phaseResults.push({
        phase,
        ok: true,
        decryptCalls: parsed.decryptCalls,
        encryptionAvailabilityCalls: parsed.encryptionAvailabilityCalls
      })
      const shouldInjectFailure = failAfterWrite && phase === 'write'
      if (shouldInjectFailure) {
        injectedFailure = true
        throw new Error('Synthetic failure after native credential persistence.')
      }
    }
    const createdOwnedItem = await itemExists(appName, keychain)
    if (!createdOwnedItem) throw new Error('Expected isolated Keychain item was not observed.')
  }
} catch {
  failure = 'Native credential validation failed; raw diagnostics were withheld.'
} finally {
  try {
    await cleanupOwnedProfile()
    profileRemoved = true
  } catch {
    failure = 'Cleanup incomplete; the local owner manifest was retained.'
  }
  try {
    const hasBundleDirectory = bundleDirectory != null
    if (hasBundleDirectory) {
      await rm(bundleDirectory, { recursive: true, force: true })
      await confirmPathAbsent(bundleDirectory)
    }
    bundleRemoved = true
  } catch {
    failure = 'Owned bundle cleanup was not confirmed.'
  }
  const childGroupsStopped = ownedGroups.size === 0
  cleanupConfirmed = profileRemoved && bundleRemoved && childGroupsStopped
  if (!cleanupConfirmed) failure = 'Owned resource cleanup was not confirmed.'
}

const failed = failure != null
process.stdout.write(
  `${JSON.stringify({
    ok: !failed,
    mode: prepareOnly ? 'prepare-only' : 'native',
    phases: phaseResults,
    cleanupConfirmed,
    profileRemoved,
    bundleRemoved,
    childGroupsStopped: ownedGroups.size === 0,
    injectedFailure,
    ...(failed ? { failedPhase, failure } : {})
  })}\n`
)
process.exitCode = failed ? 1 : 0
