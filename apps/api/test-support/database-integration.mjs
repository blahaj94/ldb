import assert from 'node:assert/strict'
import { assertIdentitySessions } from './identity-session.mjs'
import { assertRefreshRotation } from './refresh-rotation.mjs'
import { assertRefreshConcurrency } from './refresh-concurrency.mjs'
import { assertRefreshFailures } from './refresh-failures.mjs'
import { assertAuthenticationCleanup } from './cleanup-database.mjs'
import { assertCommonLogin } from './login-database.mjs'
import { assertLoginConcurrency } from './login-concurrency.mjs'
import { assertLoginFailures } from './login-failures.mjs'
import { assertLoginHttpIntegration } from './login-http-integration.mjs'
import { assertSessionHttpIntegration } from './session-http-integration.mjs'
import { assertAccountHttpIntegration } from './account-http-integration.mjs'
import { assertCharacterSearchHttpIntegration } from './character-search-http-integration.mjs'
import { assertGoogleHttpIntegration } from './google-http-integration.mjs'
import {
  assertRuntimeDatabaseFailures,
  assertRuntimeFreshStart,
  assertRuntimeHttpIntegration
} from './runtime-http-integration.mjs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { URL, fileURLToPath, pathToFileURL } from 'node:url'
import { Test } from '@nestjs/testing'
import { DataSource } from 'typeorm'
import {
  DatabaseModule,
  createDatabaseDataSource,
  createDatabaseOptions
} from '../dist/database/index.js'
import {
  MIGRATIONS_TABLE,
  assertConstraintBehavior,
  assertSchema,
  databaseSnapshot,
  waitForAuthenticatedReadiness,
  withDataSource
} from './database-contract.mjs'
import {
  POSTGRES_CHILD_DIGESTS,
  POSTGRES_DATA,
  POSTGRES_INDEX_DIGEST,
  assertResourcesAbsent,
  command,
  createPostgres,
  docker,
  newRunId,
  removeOwnedVolume,
  teardownPostgres,
  verifyApprovedImage
} from './docker-postgres.mjs'

import { assertLoginRequestStateMatrix } from './auth-login-request-contract.mjs'
import { assertSchemaFirst } from './schema-first.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const apiDirectory = fileURLToPath(new URL('..', import.meta.url))
let currentStage = 'startup'

function resourceNames(runId) {
  const name = `ldb-db-${runId.slice(0, 48)}`
  return { containerName: name, volumeName: name }
}

function announceRecovery({ runId, names = resourceNames(runId) }) {
  const { containerName, volumeName } = names
  process.stdout.write(
    `Database recovery: run=${runId} container=${containerName} volume=${volumeName}\n`
  )
}

function nodeEnvironment(extra = {}) {
  const names = [
    'PATH',
    'HOME',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH'
  ]
  return {
    ...Object.fromEntries(
      names.flatMap((name) => {
        const isVariableMissing = process.env[name] === undefined
        return isVariableMissing ? [] : [[name, process.env[name]]]
      })
    ),
    ...extra
  }
}

function databaseEnvironment(configuration) {
  return nodeEnvironment({
    DB_HOST: configuration.host,
    DB_PORT: String(configuration.port),
    DB_USERNAME: configuration.username,
    DB_PASSWORD: configuration.password,
    DB_NAME: configuration.database
  })
}

function createReadinessDataSource(configuration, timeoutMs) {
  return new DataSource({
    ...createDatabaseOptions(configuration),
    connectTimeoutMS: timeoutMs,
    extra: {
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      statement_timeout: timeoutMs
    }
  })
}

async function assertBoundedReadiness() {
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    const isAddressObject = address != null && typeof address === 'object'
    assert(isAddressObject)
    const startedAt = Date.now()
    await assert.rejects(
      waitForAuthenticatedReadiness(
        createReadinessDataSource,
        {
          host: '127.0.0.1',
          port: address.port,
          username: 'silent',
          password: 'silent',
          database: 'silent'
        },
        300
      ),
      /PostgreSQL readiness timed out/
    )
    const finishedWithinReadinessBound = Date.now() - startedAt < 2_000
    assert(finishedWithinReadinessBound)
  } finally {
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise((resolve, reject) =>
      server.close((error) => {
        const hasCloseError = error != null
        return hasCloseError ? reject(error) : resolve()
      })
    )
  }
}

async function runCompiledCli({ configuration, operation }) {
  const result = await command(
    process.execPath,
    ['--import', 'reflect-metadata', 'dist/database/cli.js', operation],
    { cwd: apiDirectory, env: databaseEnvironment(configuration), timeoutMs: 20_000 }
  )
  return result
}

async function assertCompiledDataSource(configuration) {
  const source = [
    "const { default: dataSource } = await import('./dist/database/data-source.js')",
    'await dataSource.initialize()',
    "const rows = await dataSource.query('SELECT 1 AS ready')",
    "if (rows[0]?.ready !== 1) throw new Error('probe failed')",
    'await dataSource.destroy()'
  ].join(';')
  const result = await command(
    process.execPath,
    ['--import', 'reflect-metadata', '--input-type=module', '--eval', source],
    {
      cwd: apiDirectory,
      env: databaseEnvironment(configuration),
      timeoutMs: 20_000
    }
  )
  assert.deepEqual(
    { code: result.code, signal: result.signal, stdout: result.stdout, stderr: result.stderr },
    {
      code: 0,
      signal: null,
      stdout: '',
      stderr: ''
    }
  )
}

async function assertNestLifecycle(configuration) {
  const before = await withDataSource(createDatabaseDataSource, configuration, databaseSnapshot)
  const module = await Test.createTestingModule({
    imports: [DatabaseModule.register(configuration)]
  }).compile()
  const nestDataSource = module.get(DataSource)
  assert.equal(nestDataSource.isInitialized, true)
  await module.close()
  assert.equal(nestDataSource.isInitialized, false)
  const after = await withDataSource(createDatabaseDataSource, configuration, databaseSnapshot)
  assert.deepEqual(after, before)
}

export async function assertServerAndContainer(
  resources,
  image,
  { createDataSource = createDatabaseDataSource, runDocker = docker } = {}
) {
  currentStage = 'PostgreSQL server metadata'
  await withDataSource(createDataSource, resources.configuration, async (dataSource) => {
    const [version] = await dataSource.query('SHOW server_version')
    const [directory] = await dataSource.query('SHOW data_directory')
    assert.equal(version.server_version, '18.6 (Debian 18.6-1.pgdg13+2)')
    assert.equal(directory.data_directory, POSTGRES_DATA.pgdata)
  })
  currentStage = 'container image metadata'
  const inspected = await runDocker([
    'container',
    'inspect',
    resources.containerName,
    '--format',
    '{{json .Image}} {{json .Platform}}'
  ])
  assert.equal(inspected.stdout.trim(), `${JSON.stringify(image.imageId)} "linux"`)
  currentStage = 'container architecture'
  const architecture = await runDocker(['exec', resources.containerName, 'uname', '-m'])
  const containerArchitecture = architecture.stdout.trim()
  const isArm64Platform = image.platform.includes('arm64')
  assert.equal(containerArchitecture, isArm64Platform ? 'aarch64' : 'x86_64')
}

async function assertFreshDatabaseRollback(resources) {
  const database = `ldb_rollback_${resources.runId.slice(-16)}`
  assert.match(database, /^[a-z0-9_]+$/)
  const quotedDatabase = `"${database}"`
  await withDataSource(createDatabaseDataSource, resources.configuration, (dataSource) =>
    dataSource.query(`CREATE DATABASE ${quotedDatabase}`)
  )
  const configuration = { ...resources.configuration, database }
  try {
    const before = await withDataSource(createDatabaseDataSource, configuration, databaseSnapshot)
    assert.deepEqual(before.relations, [])

    const up = await runCompiledCli({ configuration, operation: 'up' })
    assert.equal(up.code, 0)
    assert.equal(up.stderr, '')
    assert.equal(up.stdout, 'Database migration applied: 1\n')
    await withDataSource(createDatabaseDataSource, configuration, assertSchema)

    const down = await runCompiledCli({ configuration, operation: 'down' })
    assert.equal(down.code, 0)
    assert.equal(down.stderr, '')
    assert.equal(down.stdout, 'Database migration reverted\n')
    await withDataSource(createDatabaseDataSource, configuration, async (dataSource) => {
      const after = await databaseSnapshot(dataSource)
      assert.deepEqual(
        after.relations.map(({ name }) => name),
        [MIGRATIONS_TABLE]
      )
      const history = await dataSource.query(`SELECT name FROM "${MIGRATIONS_TABLE}"`)
      assert.deepEqual(history, [])
    })
  } finally {
    await withDataSource(createDatabaseDataSource, resources.configuration, (dataSource) =>
      dataSource.query(`DROP DATABASE IF EXISTS ${quotedDatabase}`)
    )
  }
}

async function runFailureScenario({ scenario, image }) {
  const runId = newRunId(scenario.replaceAll('-', ''))
  announceRecovery({ runId })
  const result = await command(process.execPath, [scriptPath], {
    cwd: apiDirectory,
    env: nodeEnvironment({
      LDB_DB_SCENARIO: scenario,
      LDB_DB_RUN_ID: runId,
      LDB_DB_PLATFORM: image.platform,
      LDB_DB_IMAGE_ID: image.imageId
    }),
    timeoutMs: 30_000
  })
  assert.equal(result.code, 1)
  assert.equal(result.signal, null)
  assert.equal(result.stderr, 'Database integration scenario failed\n')
  const didChildAnnounceReadiness = result.stdout.includes('CHILD_RESOURCE_READY\n')
  assert.equal(didChildAnnounceReadiness, true)
  await assertResourcesAbsent(runId)
}

async function runSignalScenario({ signal, stage, image }) {
  const runId = newRunId(`${signal.toLowerCase()}${stage}`)
  announceRecovery({ runId })
  const child = spawn(process.execPath, [scriptPath], {
    cwd: apiDirectory,
    env: nodeEnvironment({
      LDB_DB_SCENARIO: 'signal',
      LDB_DB_RUN_ID: runId,
      LDB_DB_PLATFORM: image.platform,
      LDB_DB_IMAGE_ID: image.imageId,
      LDB_DB_SIGNAL_STAGE: stage
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, childSignal) => resolve({ code, signal: childSignal }))
  })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Signal scenario did not become ready')),
      20_000
    )
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const isResourceReady = stdout.includes('CHILD_RESOURCE_READY\n')
      if (isResourceReady) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr.on('data', (chunk) => (stderr += chunk))
  })
  try {
    await ready
    child.kill(signal)
    let exitTimer
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error('Signal scenario did not exit')), 20_000)
      })
    ]).finally(() => clearTimeout(exitTimer))
    currentStage = `${signal} teardown result code=${String(result.code)} signal=${String(result.signal)}`
    const isInterruptSignal = signal === 'SIGINT'
    assert.deepEqual(result, { code: isInterruptSignal ? 130 : 143, signal: null })
    assert.equal(stderr, '')
  } finally {
    const hasNoExitCode = child.exitCode === null
    if (hasNoExitCode) {
      const hasNoSignalCode = child.signalCode === null
      if (hasNoSignalCode) {
        child.kill('SIGKILL')
      }
    }
    await exited.catch(() => undefined)
  }
  await assertResourcesAbsent(runId)
}

function assertInvalidScenarioConfiguration() {
  const hasScenarioConfiguration = false
  assert(hasScenarioConfiguration)
}

export function assertChildScenarioConfiguration({ runId, platform, imageId }) {
  const hasRunId = runId != null && runId !== ''
  if (!hasRunId) {
    assertInvalidScenarioConfiguration()
  }

  const hasPlatform = platform != null && platform !== ''
  if (!hasPlatform) {
    assertInvalidScenarioConfiguration()
  }

  const hasImageId = imageId != null && imageId !== ''
  if (!hasImageId) {
    assertInvalidScenarioConfiguration()
  }
}

export function shouldWaitForSignalAtStage({ scenario, signalStage, expectedStage }) {
  const isSignalScenario = scenario === 'signal'
  if (!isSignalScenario) {
    return false
  }

  const isExpectedStage = signalStage === expectedStage
  return isExpectedStage
}

async function assertOwnershipProtection() {
  const protectedRunId = newRunId('protected')
  const claimedRunId = newRunId('claimed')
  const suffix = claimedRunId.slice(0, 48)
  const volumeName = `ldb-db-${suffix}`
  announceRecovery({ runId: protectedRunId, names: { containerName: 'none', volumeName } })
  await docker([
    'volume',
    'create',
    '--label',
    `com.ldb.database-test.run=${protectedRunId}`,
    '--label',
    `com.ldb.database-test.fixture-owner=${claimedRunId}`,
    volumeName
  ])
  try {
    await assert.rejects(
      teardownPostgres({ runId: claimedRunId, containerName: `ldb-db-${suffix}`, volumeName }),
      /Database test teardown failed/
    )
    const present = await docker([
      'volume',
      'ls',
      '--filter',
      `name=^${volumeName}$`,
      '--format',
      '{{.Name}}'
    ])
    assert.equal(present.stdout.trim(), volumeName)
  } finally {
    await removeOwnedVolume(volumeName, protectedRunId)
  }
}

async function childScenario() {
  const scenario = process.env.LDB_DB_SCENARIO
  const runId = process.env.LDB_DB_RUN_ID
  const platform = process.env.LDB_DB_PLATFORM
  const signalStage = process.env.LDB_DB_SIGNAL_STAGE
  const imageId = process.env.LDB_DB_IMAGE_ID
  assertChildScenarioConfiguration({ runId, platform, imageId })
  announceRecovery({ runId })
  let receivedSignal
  let resolveSignal
  const signalPromise = new Promise((resolve) => (resolveSignal = resolve))
  const waitForSignal = async () => {
    let timer
    try {
      await Promise.race([
        signalPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Signal scenario timed out')), 20_000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const receiveSignal = (signal) => {
    receivedSignal = signal
    resolveSignal(signal)
  }
  process.once('SIGINT', () => receiveSignal('SIGINT'))
  process.once('SIGTERM', () => receiveSignal('SIGTERM'))

  let resources
  try {
    resources = await createPostgres(
      runId,
      { platform, imageId },
      {
        afterVolumeCreated: async () => {
          const shouldWaitForSignal = shouldWaitForSignalAtStage({
            scenario,
            signalStage,
            expectedStage: 'volume'
          })
          if (shouldWaitForSignal) {
            process.stdout.write('CHILD_RESOURCE_READY\n')
            await waitForSignal()
            throw new Error('Signal received')
          }
        },
        afterContainerCreated: async () => {
          const shouldWaitForSignal = shouldWaitForSignalAtStage({
            scenario,
            signalStage,
            expectedStage: 'container'
          })
          if (shouldWaitForSignal) {
            process.stdout.write('CHILD_RESOURCE_READY\n')
            await waitForSignal()
            throw new Error('Signal received')
          }
        }
      }
    )
    const isFailureScenario = scenario === 'failure'
    if (isFailureScenario) {
      process.stdout.write('CHILD_RESOURCE_READY\n')
      throw new Error('Expected scenario failure')
    }
    const isTimeoutScenario = scenario === 'timeout'
    if (isTimeoutScenario) {
      process.stdout.write('CHILD_RESOURCE_READY\n')
      await waitForAuthenticatedReadiness(
        createReadinessDataSource,
        { ...resources.configuration, password: 'intentionally-invalid' },
        500
      )
      throw new Error('Timeout scenario unexpectedly connected')
    }
    const isSignalScenario = scenario === 'signal'
    if (isSignalScenario) {
      throw new Error('Signal scenario stage is invalid')
    }
    throw new Error('Unknown child scenario')
  } catch {
    const hasReceivedSignal = receivedSignal != null
    if (hasReceivedSignal) {
      const isInterruptSignal = receivedSignal === 'SIGINT'
      process.exitCode = isInterruptSignal ? 130 : 143
      return
    }
    process.stderr.write('Database integration scenario failed\n')
    process.exitCode = 1
  } finally {
    const hasResources = resources != null
    if (hasResources) {
      await teardownPostgres(resources)
    }
  }
}

async function assertFocusedRuntime({ configuration, checkSignal }) {
  let failed = 0
  const run = async (name, operation) => {
    checkSignal()
    currentStage = name
    try {
      await operation((part) => {
        currentStage = part
      })
      process.stdout.write(`Runtime database PASS: ${name}\n`)
    } catch {
      failed += 1
      process.stdout.write(`Runtime database FAIL: ${currentStage}\n`)
    }
    checkSignal()
  }
  await run('fresh startup without automatic migration', (mark) =>
    assertRuntimeFreshStart(configuration, mark)
  )
  currentStage = 'runtime explicit compiled migration'
  const migration = await runCompiledCli({ configuration, operation: 'up' })
  assert.equal(migration.code, 0)
  assert.equal(migration.stdout, 'Database migration applied: 1\n')
  await run('default entry full HTTP flow', (mark) =>
    assertRuntimeHttpIntegration(configuration, mark)
  )
  await run('partial startup database cleanup', (mark) =>
    assertRuntimeDatabaseFailures(configuration, mark)
  )
  currentStage = `runtime focused validation: ${failed} failed`
  assert.equal(failed, 0)
}

async function primaryScenario() {
  const runtimeOnly = process.argv.includes('--runtime-only')
  let receivedSignal
  const receiveSignal = (signal) => {
    receivedSignal = signal
  }
  process.once('SIGINT', () => receiveSignal('SIGINT'))
  process.once('SIGTERM', () => receiveSignal('SIGTERM'))
  const checkSignal = () => {
    const hasReceivedSignal = receivedSignal != null
    if (hasReceivedSignal) {
      throw new Error('Database integration interrupted')
    }
  }
  const finishSignal = () => {
    const hasReceivedSignal = receivedSignal != null
    if (!hasReceivedSignal) {
      return false
    }
    const isInterruptSignal = receivedSignal === 'SIGINT'
    process.exitCode = isInterruptSignal ? 130 : 143
    return true
  }

  currentStage = 'bounded readiness regression'
  await assertBoundedReadiness()
  currentStage = 'image verification'
  const image = await verifyApprovedImage()
  checkSignal()
  const runId = newRunId('primary')
  announceRecovery({ runId })
  let resources
  try {
    currentStage = 'primary resource creation'
    resources = await createPostgres(runId, image)
    checkSignal()
    currentStage = 'authenticated readiness'
    await waitForAuthenticatedReadiness(createReadinessDataSource, resources.configuration)
    checkSignal()
    currentStage = 'server and container metadata'
    await assertServerAndContainer(resources, image)
    if (runtimeOnly) {
      await assertFocusedRuntime({ configuration: resources.configuration, checkSignal })
      return
    }
    currentStage = 'compiled data source'
    await assertCompiledDataSource(resources.configuration)
    checkSignal()

    currentStage = 'read-only fresh migration status'
    const freshBeforeShow = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      databaseSnapshot
    )
    const freshShow = await runCompiledCli({
      configuration: resources.configuration,
      operation: 'show'
    })
    assert.deepEqual(
      {
        code: freshShow.code,
        signal: freshShow.signal,
        stdout: freshShow.stdout,
        stderr: freshShow.stderr
      },
      { code: 0, signal: null, stdout: 'Database migrations pending\n', stderr: '' }
    )
    const freshAfterShow = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      databaseSnapshot
    )
    assert.deepEqual(freshAfterShow, freshBeforeShow)

    await assertRuntimeFreshStart(resources.configuration, (part) => {
      currentStage = part
    })
    currentStage = 'fresh Nest lifecycle'
    await assertNestLifecycle(resources.configuration)
    currentStage = 'initial migration CLI'
    const firstUp = await runCompiledCli({
      configuration: resources.configuration,
      operation: 'up'
    })
    assert.deepEqual(
      {
        code: firstUp.code,
        signal: firstUp.signal,
        stdout: firstUp.stdout,
        stderr: firstUp.stderr
      },
      { code: 0, signal: null, stdout: 'Database migration applied: 1\n', stderr: '' }
    )
    currentStage = 'no-op migration rerun'
    const secondUp = await runCompiledCli({
      configuration: resources.configuration,
      operation: 'up'
    })
    assert.equal(secondUp.stdout, 'Database migration applied: 0\n')
    assert.equal(secondUp.stderr, '')
    const migratedShow = await runCompiledCli({
      configuration: resources.configuration,
      operation: 'show'
    })
    assert.equal(migratedShow.code, 0)
    assert.equal(migratedShow.stdout, 'Database migrations current\n')
    assert.equal(migratedShow.stderr, '')
    checkSignal()

    currentStage = 'authentication cleanup'
    const cleanupScenarios = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) =>
        assertAuthenticationCleanup(
          source,
          resources.configuration,
          (part) => (currentStage = `authentication cleanup ${part}`)
        )
    )
    process.stdout.write(`Authentication cleanup: ${cleanupScenarios} scenarios\n`)

    await assertRuntimeDatabaseFailures(resources.configuration, (part) => {
      currentStage = part
    })
    const runtimeFlows = await assertRuntimeHttpIntegration(resources.configuration, (part) => {
      currentStage = part
    })
    process.stdout.write(
      `Default API entry HTTP/database: ${runtimeFlows} flow stages and startup cleanup\n`
    )
    checkSignal()
    currentStage = 'schema catalog verification'
    await withDataSource(createDatabaseDataSource, resources.configuration, (dataSource) =>
      assertSchema(dataSource, (part) => (currentStage = `schema catalog ${part}`))
    )
    currentStage = 'constraint behavior verification'
    await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      assertConstraintBehavior
    )
    currentStage = 'AuthLoginRequest state matrix'
    const stateMatrix = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      assertLoginRequestStateMatrix
    )
    process.stdout.write(
      `AuthLoginRequest matrix: ${stateMatrix.accepted} accepted, ${stateMatrix.rejected} rejected\n`
    )
    currentStage = 'authenticated character search'
    const searchFlows = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) =>
        assertCharacterSearchHttpIntegration(
          source,
          (part) => (currentStage = `character search ${part}`)
        )
    )
    process.stdout.write(`Character search HTTP/database/JWT/upstream: ${searchFlows} scenarios\n`)
    currentStage = 'identity session module'
    const accountFlows = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) =>
        assertAccountHttpIntegration(source, (part) => (currentStage = `account HTTP ${part}`))
    )
    process.stdout.write(
      `Account HTTP/database/JWT: ${accountFlows} scenarios; Node ${process.version}; Unicode ${process.versions.unicode}; ICU ${process.versions.icu}\n`
    )
    const identityMatrix = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) =>
        assertIdentitySessions(source, (part) => (currentStage = `identity session ${part}`))
    )
    process.stdout.write(
      `Identity session matrix: ${identityMatrix.scenarios} scenarios, ${identityMatrix.rollbackVariants} rollback variants\n`
    )
    currentStage = 'common login flow'
    const loginMatrix = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) => assertCommonLogin(source, (part) => (currentStage = `common login ${part}`))
    )
    process.stdout.write(`Common login matrix: ${loginMatrix.scenarios} scenarios\n`)
    const concurrency = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) =>
        assertLoginConcurrency(source, (part) => (currentStage = `login concurrency ${part}`))
    )
    const failures = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) => assertLoginFailures(source, (part) => (currentStage = `login failures ${part}`))
    )
    process.stdout.write(
      `Login concurrency/failure matrix: ${concurrency} concurrency/TTL, ${failures} failure scenarios\n`
    )
    const httpFlows = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) =>
        assertLoginHttpIntegration(source, (part) => (currentStage = `login HTTP ${part}`))
    )
    process.stdout.write(`Login HTTP/database/JWT: ${httpFlows} flows\n`)
    const refreshRotation = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) =>
        assertRefreshRotation(source, (part) => (currentStage = `refresh rotation ${part}`))
    )
    const refreshConcurrency = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) =>
        assertRefreshConcurrency(source, (part) => (currentStage = `refresh concurrency ${part}`))
    )
    const refreshFailures = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) =>
        assertRefreshFailures(source, (part) => (currentStage = `refresh failures ${part}`))
    )
    process.stdout.write(
      `Refresh core: ${refreshRotation} rotation/history, ${refreshConcurrency} concurrency/TTL, ${refreshFailures} failure scenarios\n`
    )
    const sessionHttpFlows = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) =>
        assertSessionHttpIntegration(source, (part) => (currentStage = `session HTTP ${part}`))
    )
    process.stdout.write(`Refresh/logout HTTP/database: ${sessionHttpFlows} scenarios\n`)
    const googleFlows = await withDataSource(
      createDatabaseDataSource,
      resources.configuration,
      (source) =>
        assertGoogleHttpIntegration(source, (part) => (currentStage = `Google HTTP ${part}`))
    )
    process.stdout.write(`Google RS256/HTTP/database/JWT: ${googleFlows} scenarios\n`)
    currentStage = 'migrated Nest lifecycle'
    await assertNestLifecycle(resources.configuration)
    checkSignal()

    currentStage = 'sanitized CLI failure'
    const failedCli = await runCompiledCli({
      configuration: { ...resources.configuration, database: 'database_does_not_exist' },
      operation: 'up'
    })
    assert.notEqual(failedCli.code, 0)
    assert.equal(failedCli.signal, null)
    assert.equal(failedCli.stdout, '')
    assert.equal(failedCli.stderr, 'Database migration failed\n')

    currentStage = 'compiled generation CLI no-op'
    const generation = await command(
      process.execPath,
      ['--import', 'reflect-metadata', 'dist/database/generate-cli.js', 'NoChanges'],
      { cwd: apiDirectory, env: databaseEnvironment(resources.configuration) }
    )
    assert.equal(generation.code, 0)
    assert.equal(generation.stdout, 'Database schema is current\n')
    assert.equal(generation.stderr, '')

    await assertSchemaFirst(
      resources.configuration,
      (part) => (currentStage = `Schema First ${part}`)
    )

    currentStage = 'fresh database rollback'
    await assertFreshDatabaseRollback(resources)
  } catch (error) {
    const hasReceivedSignal = receivedSignal != null
    if (!hasReceivedSignal) {
      throw error
    }
  } finally {
    const hasResources = resources != null
    if (hasResources) {
      await teardownPostgres(resources)
    }
    if (runtimeOnly) {
      await assertResourcesAbsent(runId)
      process.stdout.write('Runtime database owned resources absent\n')
    }
  }
  await assertResourcesAbsent(runId)

  const finishedBeforeFailureScenario = finishSignal()
  if (finishedBeforeFailureScenario) {
    return
  }

  currentStage = 'failure teardown'
  await runFailureScenario({ scenario: 'failure', image })
  const finishedAfterFailureScenario = finishSignal()
  if (finishedAfterFailureScenario) {
    return
  }
  currentStage = 'timeout teardown'
  await runFailureScenario({ scenario: 'timeout', image })
  const finishedAfterTimeoutScenario = finishSignal()
  if (finishedAfterTimeoutScenario) {
    return
  }
  currentStage = 'SIGINT teardown'
  await runSignalScenario({ signal: 'SIGINT', stage: 'volume', image })
  const finishedAfterInterruptScenario = finishSignal()
  if (finishedAfterInterruptScenario) {
    return
  }
  currentStage = 'SIGTERM teardown'
  await runSignalScenario({ signal: 'SIGTERM', stage: 'container', image })
  const finishedAfterTerminationScenario = finishSignal()
  if (finishedAfterTerminationScenario) {
    return
  }
  currentStage = 'ownership protection'
  await assertOwnershipProtection()
  const finishedAfterOwnershipScenario = finishSignal()
  if (finishedAfterOwnershipScenario) {
    return
  }

  process.stdout.write(
    [
      'Database integration passed',
      `Platform: ${image.platform}`,
      `Docker server: ${image.dockerServerVersion}`,
      'PostgreSQL server: 18.6 (Debian 18.6-1.pgdg13+2)',
      `Image index: ${POSTGRES_INDEX_DIGEST}`,
      `Image child: ${image.childDigest}`,
      `Image config: ${image.configDigest}`,
      `PGDATA: ${POSTGRES_DATA.pgdata}`,
      `Volume target: ${POSTGRES_DATA.volumeTarget}`,
      'Teardown: normal, failure, timeout, SIGINT during volume creation, SIGTERM after container creation, ownership mismatch',
      `Unverified platform: ${Object.keys(POSTGRES_CHILD_DIGESTS).find((platform) => platform !== image.platform)}`,
      'Known limit: SIGKILL, host crash, or Docker daemon loss can leave owned resources for exact-ID recovery.'
    ].join('\n') + '\n'
  )
  process.removeAllListeners('SIGINT')
  process.removeAllListeners('SIGTERM')
}

const hasScriptArgument = Boolean(process.argv[1])
if (hasScriptArgument) {
  const isDirectExecution = pathToFileURL(process.argv[1]).href === import.meta.url
  if (isDirectExecution) {
    try {
      const hasChildScenario = Boolean(process.env.LDB_DB_SCENARIO)
      if (hasChildScenario) {
        await childScenario()
      } else {
        await primaryScenario()
      }
    } catch {
      process.stderr.write(`Database integration failed at ${currentStage}\n`)
      process.exitCode = 1
    }
  }
}
