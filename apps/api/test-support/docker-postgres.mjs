import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'

export const POSTGRES_IMAGE =
  'docker.io/library/postgres:18.6-trixie@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280'
export const POSTGRES_INDEX_DIGEST = 'sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280'
export const POSTGRES_CHILD_DIGESTS = Object.freeze({
  'linux/amd64': 'sha256:7341002d2b8c7c5bdd7542a671a95b36196c0b5b888daf454ae4fc33ba5346d7',
  'linux/arm64/v8': 'sha256:6fd9e18b6fedda0a34e4d53ad6fdbd4289a217300af573c31ec7084e6d9cf329',
})
export const POSTGRES_DATA = Object.freeze({
  pgdata: '/var/lib/postgresql/18/docker',
  volumeTarget: '/var/lib/postgresql',
})

const ownershipLabel = 'com.ldb.database-test.run'
const maxOutputBytes = 1024 * 1024

function safeDockerEnvironment() {
  const names = [
    'PATH',
    'HOME',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ]
  return Object.fromEntries(names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])))
}

export function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env ?? safeDockerEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let outputExceeded = false
    let startFailed = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs ?? 30_000)
    const collect = (target, chunk) => {
      const next = target + chunk
      if (Buffer.byteLength(next) > maxOutputBytes) {
        outputExceeded = true
        child.kill('SIGKILL')
      }
      return next
    }
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout = collect(stdout, chunk)))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr = collect(stderr, chunk)))
    child.once('error', () => {
      startFailed = true
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (startFailed) {
        reject(new Error('Command failed to start'))
        return
      }
      if (outputExceeded) {
        reject(new Error('Command output limit exceeded'))
        return
      }
      if (timedOut) {
        reject(new Error('Command timed out'))
        return
      }
      resolve({ code, signal, stdout, stderr })
    })
  })
}

export async function docker(args, options = {}) {
  const result = await command('docker', args, { timeoutMs: options.timeoutMs })
  if (!options.allowFailure && (result.code !== 0 || result.signal !== null)) {
    throw new Error(`Docker command failed: ${args[0] ?? 'unknown'}`)
  }
  return result
}

function normalizeNativePlatform(os, architecture) {
  if (os !== 'linux') throw new Error('Unsupported Docker operating system')
  if (architecture === 'aarch64' || architecture === 'arm64') return 'linux/arm64/v8'
  if (architecture === 'x86_64' || architecture === 'amd64') return 'linux/amd64'
  throw new Error('Unsupported Docker architecture')
}

export async function verifyApprovedImage() {
  const info = await docker(['info', '--format', '{{json .OSType}} {{json .Architecture}} {{json .ServerVersion}}'])
  const match = info.stdout.trim().match(/^"([^"]+)" "([^"]+)" "([^"]+)"$/)
  if (!match) throw new Error('Docker platform could not be determined')
  const platform = normalizeNativePlatform(match[1], match[2])
  const expectedChildDigest = POSTGRES_CHILD_DIGESTS[platform]
  assert(expectedChildDigest, 'native platform is not approved')

  const manifestResult = await docker([
    'buildx',
    'imagetools',
    'inspect',
    POSTGRES_IMAGE,
    '--format',
    '{{json .Manifest}}',
  ], { timeoutMs: 120_000 })
  const manifest = JSON.parse(manifestResult.stdout)
  assert.equal(manifest.mediaType, 'application/vnd.oci.image.index.v1+json')
  assert.equal(manifest.digest, POSTGRES_INDEX_DIGEST)
  const child = manifest.manifests.find(
    (entry) =>
      entry.platform?.os === platform.split('/')[0] &&
      entry.platform?.architecture === platform.split('/')[1] &&
      (platform !== 'linux/arm64/v8' || entry.platform?.variant === 'v8'),
  )
  assert.equal(child?.digest, expectedChildDigest)

  const childManifestResult = await docker([
    'buildx',
    'imagetools',
    'inspect',
    `docker.io/library/postgres@${expectedChildDigest}`,
    '--raw',
  ], { timeoutMs: 120_000 })
  const childManifest = JSON.parse(childManifestResult.stdout)
  assert.equal(childManifest.mediaType, 'application/vnd.oci.image.manifest.v1+json')
  const expectedConfigDigest = childManifest.config?.digest
  assert.match(expectedConfigDigest, /^sha256:[a-f0-9]{64}$/)

  await docker(['pull', '--platform', platform, POSTGRES_IMAGE], { timeoutMs: 120_000 })
  const imageResult = await docker([
    'image',
    'inspect',
    POSTGRES_IMAGE,
    '--format',
    '{{json .RepoDigests}} {{json .Os}} {{json .Architecture}} {{json .Config.Volumes}} {{json .Id}}',
  ])
  const imageMatch = imageResult.stdout.trim().match(/^(\[[^\n]+\]) "([^"]+)" "([^"]+)" (\{[^\n]+\}) "([^"]+)"$/)
  if (!imageMatch) throw new Error('Docker image metadata could not be determined')
  const repoDigests = JSON.parse(imageMatch[1])
  const volumes = JSON.parse(imageMatch[4])
  assert(repoDigests.some((digest) => digest.endsWith(`@${POSTGRES_INDEX_DIGEST}`)))
  assert.equal(imageMatch[2], 'linux')
  assert.equal(imageMatch[3], platform.includes('arm64') ? 'arm64' : 'amd64')
  assert.deepEqual(Object.keys(volumes), [POSTGRES_DATA.volumeTarget])

  const savedConfigDigest = await savedImageConfigDigest()
  assert.equal(savedConfigDigest, expectedConfigDigest)

  return {
    platform,
    imageId: imageMatch[5],
    childDigest: expectedChildDigest,
    configDigest: expectedConfigDigest,
    dockerServerVersion: match[3],
  }
}

async function savedImageConfigDigest() {
  const directory = await mkdtemp(join(tmpdir(), 'ldb-db-image-'))
  const archivePath = join(directory, 'image.tar')
  try {
    await docker(['image', 'save', '--output', archivePath, POSTGRES_IMAGE], { timeoutMs: 120_000 })
    const archive = await open(archivePath, 'r')
    try {
      let offset = 0
      const header = Buffer.alloc(512)
      while (true) {
        const { bytesRead } = await archive.read(header, 0, header.length, offset)
        if (bytesRead !== header.length || header.every((byte) => byte === 0)) break
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
        const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
        const size = Number.parseInt(sizeText, 8)
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Saved image archive is invalid')
        if (name === 'manifest.json') {
          const content = Buffer.alloc(size)
          const result = await archive.read(content, 0, size, offset + 512)
          if (result.bytesRead !== size) throw new Error('Saved image manifest is incomplete')
          const manifest = JSON.parse(content.toString('utf8'))
          const configPath = manifest[0]?.Config
          if (typeof configPath !== 'string') throw new Error('Saved image config is missing')
          return archiveConfigDigest(configPath)
        }
        offset += 512 + Math.ceil(size / 512) * 512
      }
      throw new Error('Saved image manifest is missing')
    } finally {
      await archive.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function validateRunId(runId) {
  if (!/^[a-z0-9]{8,80}$/.test(runId)) throw new Error('Invalid database test run ID')
}

export function newRunId(prefix = 'run') {
  return `${prefix}${randomUUID().replaceAll('-', '')}`
}

export function archiveConfigDigest(configPath) {
  const hash = basename(configPath).replace(/\.json$/, '')
  assert.match(hash, /^[a-f0-9]{64}$/)
  return `sha256:${hash}`
}

export function assertContainerImageId(containerImageId, verifiedImage) {
  // Classic store는 config ID, containerd store는 index ID를 반환할 수 있다.
  assert.match(verifiedImage.imageId, /^sha256:[a-f0-9]{64}$/)
  assert.equal(containerImageId, verifiedImage.imageId)
}

export async function createPostgres(runId, verifiedImage, hooks = {}) {
  const { platform } = verifiedImage
  validateRunId(runId)
  const suffix = runId.slice(0, 48)
  const containerName = `ldb-db-${suffix}`
  const volumeName = `ldb-db-${suffix}`
  const username = `ldb_${randomBytes(10).toString('hex')}`
  const password = randomBytes(32).toString('base64url')
  const database = 'ldb_auth_test'
  const label = `${ownershipLabel}=${runId}`

  if ((await inspectOwnership('container', containerName)) !== undefined) {
    throw new Error('Database test container already exists')
  }
  if ((await inspectOwnership('volume', volumeName)) !== undefined) {
    throw new Error('Database test volume already exists')
  }
  try {
    await docker(['volume', 'create', '--label', label, volumeName])
    assert.equal(await inspectOwnership('volume', volumeName), runId)
    await hooks.afterVolumeCreated?.()
    await docker([
      'run',
      '--detach',
      '--name',
      containerName,
      '--platform',
      platform,
      '--label',
      label,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      `POSTGRES_USER=${username}`,
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      `POSTGRES_DB=${database}`,
      '--env',
      `PGDATA=${POSTGRES_DATA.pgdata}`,
      '--mount',
      `type=volume,source=${volumeName},target=${POSTGRES_DATA.volumeTarget}`,
      POSTGRES_IMAGE,
    ])
    assert.equal(await inspectOwnership('container', containerName), runId)
    await hooks.afterContainerCreated?.()
    const containerMetadata = await docker([
      'container',
      'inspect',
      containerName,
      '--format',
      '{{json .Image}} {{json .Platform}} {{json .Mounts}}',
    ])
    const metadataMatch = containerMetadata.stdout.trim().match(/^("[^"]+") ("[^"]+") (\[[^\n]+\])$/)
    if (!metadataMatch) throw new Error('Database container metadata could not be determined')
    assertContainerImageId(JSON.parse(metadataMatch[1]), verifiedImage)
    assert.equal(JSON.parse(metadataMatch[2]), 'linux')
    const mounts = JSON.parse(metadataMatch[3])
    assert.equal(
      mounts.some(
        (mount) =>
          mount.Type === 'volume' &&
          mount.Name === volumeName &&
          mount.Destination === POSTGRES_DATA.volumeTarget,
      ),
      true,
    )
    const architecture = await docker(['exec', containerName, 'uname', '-m'])
    assert.equal(architecture.stdout.trim(), platform.includes('arm64') ? 'aarch64' : 'x86_64')
    const portResult = await docker(['port', containerName, '5432/tcp'])
    const portMatch = portResult.stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)
    if (!portMatch) throw new Error('PostgreSQL loopback port could not be determined')
    return {
      runId,
      containerName,
      volumeName,
      configuration: {
        host: '127.0.0.1',
        port: Number(portMatch[1]),
        username,
        password,
        database,
      },
    }
  } catch (error) {
    await teardownPostgres({ runId, containerName, volumeName })
    throw error
  }
}

async function inspectOwnership(kind, name) {
  const listArgs =
    kind === 'container'
      ? ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']
      : ['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']
  const listed = await docker(listArgs)
  if (listed.stdout.trim() === '') return undefined
  assert.equal(listed.stdout.trim(), name)

  const inspectArgs =
    kind === 'container'
      ? ['container', 'inspect', name, '--format', `{{ index .Config.Labels "${ownershipLabel}" }}`]
      : ['volume', 'inspect', name, '--format', `{{ index .Labels "${ownershipLabel}" }}`]
  const inspected = await docker(inspectArgs)
  return inspected.stdout.trim()
}

async function removeOwnedResource(kind, name, runId) {
  const actualRunId = await inspectOwnership(kind, name)
  if (actualRunId === undefined) return
  if (actualRunId !== runId) throw new Error('Database test resource ownership mismatch')
  if (kind === 'container') await docker(['rm', '--force', name])
  else await docker(['volume', 'rm', '--force', name])
  assert.equal(await inspectOwnership(kind, name), undefined)
}

export async function removeOwnedVolume(name, runId) {
  await removeOwnedResource('volume', name, runId)
}

export async function teardownPostgres(resources) {
  const errors = []
  for (const [kind, name] of [
    ['container', resources.containerName],
    ['volume', resources.volumeName],
  ]) {
    try {
      await removeOwnedResource(kind, name, resources.runId)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Database test teardown failed')
}

export async function assertResourcesAbsent(runId) {
  validateRunId(runId)
  const suffix = runId.slice(0, 48)
  assert.equal(await inspectOwnership('container', `ldb-db-${suffix}`), undefined)
  assert.equal(await inspectOwnership('volume', `ldb-db-${suffix}`), undefined)
}
