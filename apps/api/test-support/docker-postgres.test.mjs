import assert from 'node:assert/strict'
import test from 'node:test'
import { Buffer } from 'node:buffer'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { writeFileSync } from 'node:fs'
import fsPromises, { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
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

const configHash = 'a'.repeat(64)
const manifestBytes = Buffer.from(JSON.stringify([{ Config: `${configHash}.json` }]))
const manifestLimit = 1024 * 1024

// Raw headers allow checksum, size, extension and truncation faults independently
// of the production parser. Fixtures never extract archive entries.
function tarHeader({ name, size = 0, type = '0', prefix = '', sizeBytes }) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12)
  const hasRawSize = sizeBytes != null
  if (hasRawSize) {
    sizeBytes.copy(header, 124)
  }
  header.write('00000000000\0', 136)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.write(prefix, 345, 155)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

function tarEntry({ name = 'manifest.json', content = manifestBytes, ...header }) {
  const bytes = Buffer.from(content)
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512)
  return Buffer.concat([tarHeader({ name, size: bytes.length, ...header }), bytes, padding])
}

function tarArchive(...entries) {
  return Buffer.concat([...entries, Buffer.alloc(1024)])
}

function paxRecord({ key, value }) {
  const record = `${key}=${value}\n`
  let length = Buffer.byteLength(record) + 2
  while (true) {
    const nextLength = Buffer.byteLength(`${length} ${record}`)
    const isLengthStable = nextLength === length
    if (isLengthStable) {
      return `${length} ${record}`
    }
    length = nextLength
  }
}

async function withArchive({ t, bytes, check }) {
  const directory = await mkdtemp(join(tmpdir(), 'ldb-tar-test-'))
  const archivePath = join(directory, 'image.tar')
  const handles = []
  const originalOpen = fsPromises.open
  t.mock.method(fsPromises, 'open', async (...args) => {
    const handle = await originalOpen(...args)
    handles.push(handle)
    return handle
  })
  syncBuiltinESMExports()
  try {
    await writeFile(archivePath, bytes)
    await check(archivePath)
    assert.deepEqual(await readdir(directory), ['image.tar'], 'entries must not be extracted')
    assert.equal(handles.length, 1)
    for (const handle of handles) {
      assert.equal(handle.fd, -1, 'archive handle must close before settlement')
    }
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(directory, { recursive: true, force: true })
  }
}

async function acceptsArchive(t, bytes) {
  await withArchive({
    t,
    bytes,
    check: async (path) => {
      assert.equal(await postgres.readArchiveConfigDigest(path), `sha256:${configHash}`)
    }
  })
}

async function rejectsArchive({ t, bytes, error }) {
  await withArchive({
    t,
    bytes,
    check: (path) => assert.rejects(postgres.readArchiveConfigDigest(path), error)
  })
}

test('preserves padding boundaries before and after the manifest and drains large layers', async (t) => {
  for (const size of [0, 1, 511, 512, 513, 2 * manifestLimit + 1]) {
    await t.test(`layer size ${size}`, async (t) => {
      const layer = tarEntry({ name: 'layer.tar', content: Buffer.alloc(size, 7) })
      await acceptsArchive(t, tarArchive(layer, tarEntry({}), layer))
    })
  }
})

test('preserves JSON first-config semantics and both config path formats', async (t) => {
  for (const Config of [`${configHash}.json`, `blobs/sha256/${configHash}`]) {
    await t.test(Config, async (t) => {
      const content = JSON.stringify([{ Config, extra: true }, { Config: 'ignored.json' }])
      await acceptsArchive(t, tarArchive(tarEntry({ content })))
    })
  }
})

test('preserves rejection of missing manifest, incomplete manifest and invalid JSON/config', async (t) => {
  const cases = [
    {
      name: 'missing',
      bytes: tarArchive(tarEntry({ name: 'layer' })),
      error: /manifest is missing/
    },
    {
      name: 'truncated manifest',
      bytes: Buffer.concat([tarHeader({ name: 'manifest.json', size: 2048 }), manifestBytes])
    },
    { name: 'JSON', bytes: tarArchive(tarEntry({ content: '{' })), error: SyntaxError },
    {
      name: 'empty array',
      bytes: tarArchive(tarEntry({ content: '[]' })),
      error: /config is missing/
    },
    {
      name: 'nonstring config',
      bytes: tarArchive(tarEntry({ content: '[{"Config":1}]' })),
      error: /config is missing/
    },
    {
      name: 'invalid digest',
      bytes: tarArchive(tarEntry({ content: '[{"Config":"bad.json"}]' })),
      error: assert.AssertionError
    }
  ]
  for (const { name, ...fixture } of cases) {
    await t.test(name, (t) => rejectsArchive({ t, ...fixture }))
  }
})

test('accepts a manifest at the exact 1 MiB byte boundary', async (t) => {
  const content = Buffer.concat([
    manifestBytes,
    Buffer.alloc(manifestLimit - manifestBytes.length, 32)
  ])
  await acceptsArchive(t, tarArchive(tarEntry({ content })))
})

test('rejects a manifest one byte above 1 MiB', async (t) => {
  const content = Buffer.concat([
    manifestBytes,
    Buffer.alloc(manifestLimit + 1 - manifestBytes.length, 32)
  ])
  await rejectsArchive({ t, bytes: tarArchive(tarEntry({ content })), error: /manifest.*limit/i })
})

test('rejects duplicate manifests even after a drained layer', async (t) => {
  const bytes = tarArchive(
    tarEntry({}),
    tarEntry({ name: 'layer', content: Buffer.alloc(70000) }),
    tarEntry({})
  )
  await rejectsArchive({ t, bytes, error: /duplicate.*manifest/i })
})

test('uses PAX and GNU effective paths instead of raw header names', async (t) => {
  const extensions = [
    { name: 'PaxHeader', type: 'x', content: paxRecord({ key: 'path', value: 'manifest.json' }) },
    { name: '././@LongLink', type: 'L', content: 'manifest.json\0' }
  ]
  for (const extension of extensions) {
    await t.test(extension.type, async (t) => {
      await acceptsArchive(t, tarArchive(tarEntry(extension), tarEntry({ name: 'placeholder' })))
    })
  }
  await t.test('PAX renames raw manifest away', async (t) => {
    const extension = tarEntry({
      name: 'PaxHeader',
      type: 'x',
      content: paxRecord({ key: 'path', value: 'other.json' })
    })
    await rejectsArchive({
      t,
      bytes: tarArchive(extension, tarEntry({})),
      error: /manifest is missing/
    })
  })
  await t.test('ustar prefix is part of path', async (t) => {
    await rejectsArchive({
      t,
      bytes: tarArchive(tarEntry({ prefix: 'nested' })),
      error: /manifest is missing/
    })
  })
  await t.test('effective path duplicate', async (t) => {
    const extension = tarEntry(extensions[0])
    await rejectsArchive({
      t,
      bytes: tarArchive(tarEntry({}), extension, tarEntry({ name: 'alias' })),
      error: /duplicate.*manifest/i
    })
  })
})

test('uses PAX size for framing and the manifest limit', async (t) => {
  await t.test('size overrides raw header', async (t) => {
    const extension = tarEntry({
      name: 'PaxHeader',
      type: 'x',
      content: paxRecord({ key: 'size', value: manifestBytes.length })
    })
    await acceptsArchive(t, tarArchive(extension, tarEntry({ size: 1 })))
  })
  await t.test('oversized declared manifest', async (t) => {
    const extension = tarEntry({
      name: 'PaxHeader',
      type: 'x',
      content: paxRecord({ key: 'size', value: manifestLimit + 1 })
    })
    await rejectsArchive({
      t,
      bytes: tarArchive(extension, tarEntry({})),
      error: /manifest.*limit/i
    })
  })
})

test('follows gzip interpretation and rejects compression corruption after the manifest', async (t) => {
  const bytes = gzipSync(tarArchive(tarEntry({})))
  await t.test('gzip archive', (t) => acceptsArchive(t, bytes))
  await t.test('broken gzip trailer', async (t) => {
    const corrupt = Buffer.from(bytes)
    corrupt[corrupt.length - 8] ^= 0xff
    await rejectsArchive({ t, bytes: corrupt })
  })
})

test('rejects parser-detected header and body corruption across the whole archive', async (t) => {
  const badChecksum = tarHeader({ name: 'layer' })
  badChecksum[0] ^= 1
  const badSize = tarHeader({
    name: 'layer',
    sizeBytes: Buffer.from([0x80, ...Array(11).fill(0xff)])
  })
  // A complete nonmanifest header promises a body the archive does not supply.
  const truncatedLayer = Buffer.concat([tarHeader({ name: 'layer', size: 2048 }), Buffer.alloc(10)])
  const cases = [
    { name: 'checksum before manifest', bytes: tarArchive(badChecksum, tarEntry({})) },
    { name: 'checksum after manifest', bytes: tarArchive(tarEntry({}), badChecksum) },
    { name: 'parser size error', bytes: tarArchive(tarEntry({}), badSize) },
    { name: 'truncated layer after manifest', bytes: Buffer.concat([tarEntry({}), truncatedLayer]) }
  ]
  for (const { name, bytes } of cases) {
    await t.test(name, (t) => rejectsArchive({ t, bytes }))
  }
})

test('closes the archive on read errors and reports open failures', async (t) => {
  await withArchive({
    t,
    bytes: Buffer.alloc(0),
    check: async (path) => {
      const directory = dirname(path)
      await assert.rejects(postgres.readArchiveConfigDigest(join(directory, 'missing')), {
        code: 'ENOENT'
      })
      await assert.rejects(postgres.readArchiveConfigDigest(directory), { code: 'EISDIR' })
    }
  })
})

test('removes the temporary saved archive on success, parser/JSON failure and Docker save failure', async (t) => {
  const cases = [
    { name: 'success', bytes: tarArchive(tarEntry({})) },
    { name: 'JSON failure', bytes: tarArchive(tarEntry({ content: '{' })), error: SyntaxError },
    {
      name: 'parser failure',
      bytes: Buffer.concat([tarEntry({}), tarHeader({ name: 'layer', size: 2048 })]),
      error: Error
    },
    { name: 'save failure', bytes: Buffer.alloc(10), saveCode: 1, error: /Docker command failed/ }
  ]
  for (const { name, bytes, saveCode = 0, error } of cases) {
    await t.test(name, async (t) => {
      let savedPath
      const childDigest = postgres.POSTGRES_CHILD_DIGESTS['linux/arm64/v8']
      t.mock.method(childProcess, 'spawn', (program, args) => {
        assert.equal(program, 'docker')
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        const operation = args.slice(0, 2).join(' ')
        let output = ''
        let code = 0
        switch (operation) {
          case 'info --format':
            output = '"linux" "aarch64" "29.7.2"'
            break
          case 'buildx imagetools': {
            const isChildRequest = args.includes('--raw')
            const metadata = isChildRequest
              ? {
                  mediaType: 'application/vnd.oci.image.manifest.v1+json',
                  config: { digest: `sha256:${configHash}` }
                }
              : {
                  mediaType: 'application/vnd.oci.image.index.v1+json',
                  digest: postgres.POSTGRES_INDEX_DIGEST,
                  manifests: [
                    {
                      digest: childDigest,
                      platform: { os: 'linux', architecture: 'arm64', variant: 'v8' }
                    }
                  ]
                }
            output = JSON.stringify(metadata)
            break
          }
          case 'pull --platform':
            break
          case 'image inspect':
            output = `${JSON.stringify([`postgres@${postgres.POSTGRES_INDEX_DIGEST}`])} "linux" "arm64" {"/var/lib/postgresql":{}} "${postgres.POSTGRES_INDEX_DIGEST}"`
            break
          case 'image save':
            savedPath = args[3]
            writeFileSync(savedPath, bytes)
            code = saveCode
            break
          default:
            assert.fail(`Unexpected Docker fixture operation: ${operation}`)
        }
        queueMicrotask(() => {
          child.stdout.end(output)
          child.stderr.end()
          child.emit('close', code, null)
        })
        return child
      })
      syncBuiltinESMExports()
      try {
        const shouldReject = error != null
        if (shouldReject) {
          await assert.rejects(postgres.verifyApprovedImage(), error)
        } else {
          const verified = await postgres.verifyApprovedImage()
          assert.equal(verified.configDigest, `sha256:${configHash}`)
        }
        assert.equal(typeof savedPath, 'string')
        await assert.rejects(fsPromises.stat(dirname(savedPath)), { code: 'ENOENT' })
      } finally {
        t.mock.restoreAll()
        syncBuiltinESMExports()
      }
    })
  }
})
