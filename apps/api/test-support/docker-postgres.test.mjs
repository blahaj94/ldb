import assert from 'node:assert/strict'
import test from 'node:test'
import * as postgres from './docker-postgres.mjs'

test('container identity accepts verified classic and containerd image IDs and rejects substitution', () => {
  const configDigest = `sha256:${'a'.repeat(64)}`
  for (const imageId of [configDigest, postgres.POSTGRES_INDEX_DIGEST]) {
    const verifiedImage = { imageId, configDigest }
    assert.doesNotThrow(() => postgres.assertContainerImageId(imageId, verifiedImage))
    assert.throws(() => postgres.assertContainerImageId(`sha256:${'b'.repeat(64)}`, verifiedImage))
  }
})

test('saved archive config names support classic JSON and containerd blob paths', () => {
  const hash = 'a'.repeat(64)
  assert.equal(postgres.archiveConfigDigest(`${hash}.json`), `sha256:${hash}`)
  assert.equal(postgres.archiveConfigDigest(`blobs/sha256/${hash}`), `sha256:${hash}`)
  assert.throws(() => postgres.archiveConfigDigest('unexpected.json'))
})
