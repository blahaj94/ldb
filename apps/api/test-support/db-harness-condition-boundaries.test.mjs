import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as databaseIntegration from './database-integration.mjs'
import * as postgres from './docker-postgres.mjs'

function resultWithReads({ code, signal, reads }) {
  return {
    get code() {
      reads.push('code')
      return code
    },
    get signal() {
      reads.push('signal')
      return signal
    }
  }
}

function platformEntry({ os = 'linux', architecture = 'amd64', variant = 'v8', reads }) {
  return {
    platform: {
      get os() {
        reads.push('os')
        return os
      },
      get architecture() {
        reads.push('architecture')
        return architecture
      },
      get variant() {
        reads.push('variant')
        return variant
      }
    }
  }
}

test('Docker failure guards preserve allowFailure and exit/signal evaluation boundaries', () => {
  const allowedReads = []
  const allowed = resultWithReads({ code: 1, signal: 'SIGTERM', reads: allowedReads })
  assert.equal(postgres.shouldThrowDockerFailure({ allowFailure: true, result: allowed }), false)
  assert.deepEqual(allowedReads, [])

  const failedReads = []
  const failed = resultWithReads({ code: 1, signal: 'SIGTERM', reads: failedReads })
  assert.equal(postgres.shouldThrowDockerFailure({ allowFailure: false, result: failed }), true)
  assert.deepEqual(failedReads, ['code'])

  const signaledReads = []
  const signaled = resultWithReads({ code: 0, signal: 'SIGTERM', reads: signaledReads })
  assert.equal(postgres.shouldThrowDockerFailure({ allowFailure: false, result: signaled }), true)
  assert.deepEqual(signaledReads, ['code', 'signal'])
})

test('approved child digest checks keep missing and empty values as separate guards', () => {
  assert.doesNotThrow(() => postgres.assertApprovedChildDigest('sha256:' + 'a'.repeat(64)))
  assert.throws(() => postgres.assertApprovedChildDigest(undefined), {
    name: 'AssertionError',
    message: 'native platform is not approved'
  })
  assert.throws(() => postgres.assertApprovedChildDigest(''), {
    name: 'AssertionError',
    message: 'native platform is not approved'
  })
})

test('image platform matching guards variant reads behind OS and architecture matches', () => {
  const osMismatchReads = []
  assert.equal(
    postgres.matchesImagePlatform(
      platformEntry({ os: 'darwin', architecture: 'arm64', reads: osMismatchReads }),
      'linux/arm64/v8'
    ),
    false
  )
  assert.deepEqual(osMismatchReads, ['os'])

  const architectureMismatchReads = []
  assert.equal(
    postgres.matchesImagePlatform(
      platformEntry({ architecture: 'amd64', reads: architectureMismatchReads }),
      'linux/arm64/v8'
    ),
    false
  )
  assert.deepEqual(architectureMismatchReads, ['os', 'architecture'])

  const variantMismatchReads = []
  assert.equal(
    postgres.matchesImagePlatform(
      platformEntry({ architecture: 'arm64', variant: 'wrong', reads: variantMismatchReads }),
      'linux/arm64/v8'
    ),
    false
  )
  assert.deepEqual(variantMismatchReads, ['os', 'architecture', 'variant'])

  const amd64Reads = []
  assert.equal(
    postgres.matchesImagePlatform(
      platformEntry({ architecture: 'amd64', variant: 'unexpected', reads: amd64Reads }),
      'linux/amd64'
    ),
    true
  )
  assert.deepEqual(amd64Reads, ['os', 'architecture'])
})

test('volume ownership matching guards name and destination reads', () => {
  const nonVolumeReads = []
  const nonVolumeMount = {
    Type: 'bind',
    get Name() {
      nonVolumeReads.push('name')
      return 'owned'
    },
    get Destination() {
      nonVolumeReads.push('destination')
      return postgres.POSTGRES_DATA.volumeTarget
    }
  }
  assert.equal(postgres.hasOwnedDataVolumeMount([nonVolumeMount], 'owned'), false)
  assert.deepEqual(nonVolumeReads, [])

  const wrongNameReads = []
  const wrongNameMount = {
    Type: 'volume',
    get Name() {
      wrongNameReads.push('name')
      return 'other'
    },
    get Destination() {
      wrongNameReads.push('destination')
      return postgres.POSTGRES_DATA.volumeTarget
    }
  }
  assert.equal(postgres.hasOwnedDataVolumeMount([wrongNameMount], 'owned'), false)
  assert.deepEqual(wrongNameReads, ['name'])

  const ownedMount = {
    Type: 'volume',
    Name: 'owned',
    Destination: postgres.POSTGRES_DATA.volumeTarget
  }
  assert.equal(postgres.hasOwnedDataVolumeMount([ownedMount], 'owned'), true)
})

test('child configuration and signal-stage guards keep each requirement independent', () => {
  assert.doesNotThrow(() =>
    databaseIntegration.assertChildScenarioConfiguration({
      runId: 'run12345678',
      platform: 'linux/arm64/v8',
      imageId: 'sha256:' + 'a'.repeat(64)
    })
  )
  for (const configuration of [
    { runId: '', platform: 'linux/arm64/v8', imageId: 'image' },
    { runId: 'run12345678', platform: '', imageId: 'image' },
    { runId: 'run12345678', platform: 'linux/arm64/v8', imageId: '' }
  ]) {
    assert.throws(() => databaseIntegration.assertChildScenarioConfiguration(configuration), {
      name: 'AssertionError',
      message: 'The expression evaluated to a falsy value:\n\n  assert(hasScenarioConfiguration)\n'
    })
  }

  assert.equal(
    databaseIntegration.shouldWaitForSignalAtStage({
      scenario: 'failure',
      signalStage: 'volume',
      expectedStage: 'volume'
    }),
    false
  )
  assert.equal(
    databaseIntegration.shouldWaitForSignalAtStage({
      scenario: 'signal',
      signalStage: 'volume',
      expectedStage: 'volume'
    }),
    true
  )
  assert.equal(
    databaseIntegration.shouldWaitForSignalAtStage({
      scenario: 'signal',
      signalStage: 'container',
      expectedStage: 'volume'
    }),
    false
  )
})

test('importing database integration does not invoke the direct runner', async () => {
  const apiDirectory = fileURLToPath(new URL('..', import.meta.url))
  const { command } = postgres
  const result = await command(
    process.execPath,
    ['--input-type=module', '--eval', "await import('./test-support/database-integration.mjs')"],
    { cwd: apiDirectory }
  )
  assert.deepEqual(result, { code: 0, signal: null, stdout: '', stderr: '' })
})
