import assert from 'node:assert/strict'
import test from 'node:test'
import { assertServerAndContainer } from './database-integration.mjs'
import { POSTGRES_DATA, POSTGRES_INDEX_DIGEST } from './docker-postgres.mjs'

const configDigest = `sha256:${'a'.repeat(64)}`
const resources = { containerName: 'metadata-test-container', configuration: {} }

function environment({ image, overrides = {} }) {
  const calls = []
  const dataSource = {
    isInitialized: false,
    initialize: async () => {
      dataSource.isInitialized = true
    },
    query: async (sql) => {
      calls.push(sql)
      const isServerVersionQuery = sql === 'SHOW server_version'
      if (isServerVersionQuery) {
        return [{ server_version: '18.6 (Debian 18.6-1.pgdg13+2)' }]
      }
      assert.equal(sql, 'SHOW data_directory')
      return [{ data_directory: POSTGRES_DATA.pgdata }]
    },
    destroy: async () => {
      dataSource.isInitialized = false
      calls.push('destroy')
    }
  }
  const runDocker = async (args) => {
    calls.push(args)
    const isContainerInspection = args[0] === 'container'
    if (isContainerInspection) {
      assert.deepEqual(args, [
        'container',
        'inspect',
        resources.containerName,
        '--format',
        '{{json .Image}} {{json .Platform}}'
      ])
      const imageIdJson = JSON.stringify(overrides.imageId ?? image.imageId)
      const platformJson = JSON.stringify(overrides.platform ?? 'linux')
      return { stdout: `${imageIdJson} ${platformJson}\n` }
    }
    assert.deepEqual(args, ['exec', resources.containerName, 'uname', '-m'])
    let architecture = overrides.architecture
    const hasArchitectureOverride = architecture != null
    if (!hasArchitectureOverride) {
      const isArm64Platform = image.platform.includes('arm64')
      architecture = isArm64Platform ? 'aarch64' : 'x86_64'
    }
    return { stdout: `${architecture}\n` }
  }
  return { calls, dataSource, dependencies: { createDataSource: () => dataSource, runDocker } }
}

test('later server/container stage accepts the verified classic and containerd IDs on both platforms', async () => {
  for (const imageId of [configDigest, POSTGRES_INDEX_DIGEST]) {
    for (const platform of ['linux/arm64/v8', 'linux/amd64']) {
      const image = { imageId, platform }
      const fixture = environment({ image })
      await assertServerAndContainer(resources, image, fixture.dependencies)
      assert.deepEqual(fixture.calls.slice(0, 3), [
        'SHOW server_version',
        'SHOW data_directory',
        'destroy'
      ])
      assert.equal(fixture.calls.length, 5)
      assert.equal(fixture.dataSource.isInitialized, false)
    }
  }
})

test('later server/container stage rejects a different image, platform or architecture', async () => {
  const image = { imageId: POSTGRES_INDEX_DIGEST, platform: 'linux/arm64/v8' }
  for (const overrides of [
    { imageId: configDigest },
    { platform: 'windows' },
    { architecture: 'x86_64' }
  ]) {
    const fixture = environment({ image, overrides })
    await assert.rejects(assertServerAndContainer(resources, image, fixture.dependencies), {
      code: 'ERR_ASSERTION'
    })
    assert.equal(fixture.dataSource.isInitialized, false)
  }
})
