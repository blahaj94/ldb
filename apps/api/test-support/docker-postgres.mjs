import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { pipeline } from 'node:stream/promises'
import { Parser } from 'tar'

export const POSTGRES_IMAGE =
  'docker.io/library/postgres:18.6-trixie@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280'
export const POSTGRES_INDEX_DIGEST =
  'sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280'
export const POSTGRES_CHILD_DIGESTS = Object.freeze({
  'linux/amd64': 'sha256:7341002d2b8c7c5bdd7542a671a95b36196c0b5b888daf454ae4fc33ba5346d7',
  'linux/arm64/v8': 'sha256:6fd9e18b6fedda0a34e4d53ad6fdbd4289a217300af573c31ec7084e6d9cf329'
})
export const POSTGRES_DATA = Object.freeze({
  pgdata: '/var/lib/postgresql/18/docker',
  volumeTarget: '/var/lib/postgresql'
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
    'DOCKER_CERT_PATH'
  ]
  return Object.fromEntries(
    names.flatMap((name) => {
      const isVariableMissing = process.env[name] === undefined
      return isVariableMissing ? [] : [[name, process.env[name]]]
    })
  )
}

export function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env ?? safeDockerEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
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
    const collect = ({ output, chunk }) => {
      const next = output + chunk
      const exceedsOutputLimit = Buffer.byteLength(next) > maxOutputBytes
      if (exceedsOutputLimit) {
        outputExceeded = true
        child.kill('SIGKILL')
      }
      return next
    }
    child.stdout
      .setEncoding('utf8')
      .on('data', (chunk) => (stdout = collect({ output: stdout, chunk })))
    child.stderr
      .setEncoding('utf8')
      .on('data', (chunk) => (stderr = collect({ output: stderr, chunk })))
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
  const shouldRejectFailure = !options.allowFailure
  const hasFailedExit = shouldRejectFailure && result.code !== 0
  const hasExitSignal = shouldRejectFailure && !hasFailedExit && result.signal !== null
  const shouldThrow = shouldRejectFailure && (hasFailedExit || hasExitSignal)
  if (shouldThrow) {
    throw new Error(`Docker command failed: ${args[0] ?? 'unknown'}`)
  }
  return result
}

function normalizeNativePlatform({ os, architecture }) {
  const isLinux = os === 'linux'
  if (!isLinux) {
    throw new Error('Unsupported Docker operating system')
  }
  const isArm64Architecture = architecture === 'aarch64' || architecture === 'arm64'
  if (isArm64Architecture) {
    return 'linux/arm64/v8'
  }
  const isAmd64Architecture = architecture === 'x86_64' || architecture === 'amd64'
  if (isAmd64Architecture) {
    return 'linux/amd64'
  }
  throw new Error('Unsupported Docker architecture')
}

export async function verifyApprovedImage() {
  const info = await docker([
    'info',
    '--format',
    '{{json .OSType}} {{json .Architecture}} {{json .ServerVersion}}'
  ])
  const match = info.stdout.trim().match(/^"([^"]+)" "([^"]+)" "([^"]+)"$/)
  const hasPlatformMetadata = match != null
  if (!hasPlatformMetadata) {
    throw new Error('Docker platform could not be determined')
  }
  const platform = normalizeNativePlatform({ os: match[1], architecture: match[2] })
  const expectedChildDigest = POSTGRES_CHILD_DIGESTS[platform]
  const hasApprovedChildDigest = expectedChildDigest != null && expectedChildDigest !== ''
  assert(hasApprovedChildDigest, 'native platform is not approved')

  const manifestResult = await docker(
    ['buildx', 'imagetools', 'inspect', POSTGRES_IMAGE, '--format', '{{json .Manifest}}'],
    { timeoutMs: 120_000 }
  )
  const manifest = JSON.parse(manifestResult.stdout)
  assert.equal(manifest.mediaType, 'application/vnd.oci.image.index.v1+json')
  assert.equal(manifest.digest, POSTGRES_INDEX_DIGEST)
  const child = manifest.manifests.find((entry) => {
    const hasMatchingOs = entry.platform?.os === platform.split('/')[0]
    const hasMatchingArchitecture =
      hasMatchingOs && entry.platform?.architecture === platform.split('/')[1]
    const requiresArm64Variant = hasMatchingArchitecture && platform === 'linux/arm64/v8'
    const hasArm64Variant = requiresArm64Variant && entry.platform?.variant === 'v8'
    const hasMatchingVariant = !requiresArm64Variant || hasArm64Variant
    const isMatchingPlatform = hasMatchingOs && hasMatchingArchitecture && hasMatchingVariant
    return isMatchingPlatform
  })
  assert.equal(child?.digest, expectedChildDigest)

  const childManifestResult = await docker(
    [
      'buildx',
      'imagetools',
      'inspect',
      `docker.io/library/postgres@${expectedChildDigest}`,
      '--raw'
    ],
    { timeoutMs: 120_000 }
  )
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
    '{{json .RepoDigests}} {{json .Os}} {{json .Architecture}} {{json .Config.Volumes}} {{json .Id}}'
  ])
  const imageMatch = imageResult.stdout
    .trim()
    .match(/^(\[[^\n]+\]) "([^"]+)" "([^"]+)" (\{[^\n]+\}) "([^"]+)"$/)
  const hasImageMetadata = imageMatch != null
  if (!hasImageMetadata) {
    throw new Error('Docker image metadata could not be determined')
  }
  const repoDigests = JSON.parse(imageMatch[1])
  const volumes = JSON.parse(imageMatch[4])
  const hasApprovedIndexDigest = repoDigests.some((digest) =>
    digest.endsWith(`@${POSTGRES_INDEX_DIGEST}`)
  )
  assert(hasApprovedIndexDigest)
  assert.equal(imageMatch[2], 'linux')
  const imageArchitecture = imageMatch[3]
  const isArm64Platform = platform.includes('arm64')
  assert.equal(imageArchitecture, isArm64Platform ? 'arm64' : 'amd64')
  assert.deepEqual(Object.keys(volumes), [POSTGRES_DATA.volumeTarget])

  const savedConfigDigest = await savedImageConfigDigest()
  assert.equal(savedConfigDigest, expectedConfigDigest)

  return {
    platform,
    imageId: imageMatch[5],
    childDigest: expectedChildDigest,
    configDigest: expectedConfigDigest,
    dockerServerVersion: match[3]
  }
}

async function savedImageConfigDigest() {
  const directory = await mkdtemp(join(tmpdir(), 'ldb-db-image-'))
  const archivePath = join(directory, 'image.tar')
  try {
    await docker(['image', 'save', '--output', archivePath, POSTGRES_IMAGE], { timeoutMs: 120_000 })
    return await readArchiveConfigDigest(archivePath)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function readArchiveConfigDigest(archivePath) {
  const maxManifestBytes = 1024 * 1024
  const parser = new Parser({ strict: true })
  const chunks = []
  let hasManifest = false
  let manifestBytes = 0
  parser.on('entry', (entry) => {
    const isManifestEntry = entry.path === 'manifest.json'
    if (!isManifestEntry) {
      entry.resume()
      return
    }
    if (hasManifest) {
      parser.abort(new Error('Duplicate saved image manifest'))
      return
    }
    hasManifest = true
    const exceedsManifestLimit = entry.size > maxManifestBytes
    if (exceedsManifestLimit) {
      parser.abort(new Error('Saved image manifest exceeds byte limit'))
      return
    }
    entry.on('data', (chunk) => {
      manifestBytes += chunk.length
      const exceedsManifestLimit = manifestBytes > maxManifestBytes
      if (exceedsManifestLimit) {
        parser.abort(new Error('Saved image manifest exceeds byte limit'))
        return
      }
      chunks.push(chunk)
    })
    entry.resume()
  })

  const archive = await open(archivePath, 'r')
  try {
    // Consume to parser completion: a valid manifest cannot hide later corruption.
    // strict follows node-tar detection, not a guarantee of every missing end block.
    await pipeline(archive.createReadStream(), parser)
  } catch (error) {
    // Parser is an EventEmitter, not a Node Writable; pipeline cannot destroy it.
    // abort also closes a compressed archive's decompressor on failure.
    parser.abort(error)
    throw error
  } finally {
    await archive.close()
  }

  if (!hasManifest) {
    throw new Error('Saved image manifest is missing')
  }
  const content = Buffer.concat(chunks, manifestBytes)
  const manifest = JSON.parse(content.toString('utf8'))
  const configPath = manifest[0]?.Config
  const isConfigPathString = typeof configPath === 'string'
  if (!isConfigPathString) {
    throw new Error('Saved image config is missing')
  }
  return archiveConfigDigest(configPath)
}

function validateRunId(runId) {
  const isRunIdValid = /^[a-z0-9]{8,80}$/.test(runId)
  if (!isRunIdValid) {
    throw new Error('Invalid database test run ID')
  }
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

  const hasExistingContainer =
    (await inspectOwnership({ kind: 'container', name: containerName })) !== undefined
  if (hasExistingContainer) {
    throw new Error('Database test container already exists')
  }
  const hasExistingVolume =
    (await inspectOwnership({ kind: 'volume', name: volumeName })) !== undefined
  if (hasExistingVolume) {
    throw new Error('Database test volume already exists')
  }
  try {
    await docker(['volume', 'create', '--label', label, volumeName])
    assert.equal(await inspectOwnership({ kind: 'volume', name: volumeName }), runId)
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
      POSTGRES_IMAGE
    ])
    assert.equal(await inspectOwnership({ kind: 'container', name: containerName }), runId)
    await hooks.afterContainerCreated?.()
    const containerMetadata = await docker([
      'container',
      'inspect',
      containerName,
      '--format',
      '{{json .Image}} {{json .Platform}} {{json .Mounts}}'
    ])
    const metadataMatch = containerMetadata.stdout
      .trim()
      .match(/^("[^"]+") ("[^"]+") (\[[^\n]+\])$/)
    const hasContainerMetadata = metadataMatch != null
    if (!hasContainerMetadata) {
      throw new Error('Database container metadata could not be determined')
    }
    assertContainerImageId(JSON.parse(metadataMatch[1]), verifiedImage)
    assert.equal(JSON.parse(metadataMatch[2]), 'linux')
    const mounts = JSON.parse(metadataMatch[3])
    const hasOwnedDataVolume = mounts.some((mount) => {
      const isVolumeMount = mount.Type === 'volume'
      const hasMatchingName = isVolumeMount && mount.Name === volumeName
      const hasMatchingDestination =
        hasMatchingName && mount.Destination === POSTGRES_DATA.volumeTarget
      const isOwnedDataVolume = isVolumeMount && hasMatchingName && hasMatchingDestination
      return isOwnedDataVolume
    })
    assert.equal(hasOwnedDataVolume, true)
    const architecture = await docker(['exec', containerName, 'uname', '-m'])
    const containerArchitecture = architecture.stdout.trim()
    const isArm64Platform = platform.includes('arm64')
    assert.equal(containerArchitecture, isArm64Platform ? 'aarch64' : 'x86_64')
    const portResult = await docker(['port', containerName, '5432/tcp'])
    const portMatch = portResult.stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)
    const hasLoopbackPort = portMatch != null
    if (!hasLoopbackPort) {
      throw new Error('PostgreSQL loopback port could not be determined')
    }
    return {
      runId,
      containerName,
      volumeName,
      configuration: {
        host: '127.0.0.1',
        port: Number(portMatch[1]),
        username,
        password,
        database
      }
    }
  } catch (error) {
    await teardownPostgres({ runId, containerName, volumeName })
    throw error
  }
}

async function inspectOwnership({ kind, name }) {
  const isContainerListing = kind === 'container'
  const listArgs = isContainerListing
    ? ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']
    : ['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}']
  const listed = await docker(listArgs)
  const isResourceAbsent = listed.stdout.trim() === ''
  if (isResourceAbsent) {
    return undefined
  }
  assert.equal(listed.stdout.trim(), name)

  const isContainerInspection = kind === 'container'
  const inspectArgs = isContainerInspection
    ? ['container', 'inspect', name, '--format', `{{ index .Config.Labels "${ownershipLabel}" }}`]
    : ['volume', 'inspect', name, '--format', `{{ index .Labels "${ownershipLabel}" }}`]
  const inspected = await docker(inspectArgs)
  return inspected.stdout.trim()
}

async function removeOwnedResource({ kind, name, runId }) {
  const actualRunId = await inspectOwnership({ kind, name })
  const isResourceAbsent = actualRunId === undefined
  if (isResourceAbsent) {
    return
  }
  const hasOwnershipMismatch = actualRunId !== runId
  if (hasOwnershipMismatch) {
    throw new Error('Database test resource ownership mismatch')
  }
  const isContainer = kind === 'container'
  if (isContainer) {
    await docker(['rm', '--force', name])
  } else {
    await docker(['volume', 'rm', '--force', name])
  }
  assert.equal(await inspectOwnership({ kind, name }), undefined)
}

export async function removeOwnedVolume(name, runId) {
  await removeOwnedResource({ kind: 'volume', name, runId })
}

export async function teardownPostgres(resources) {
  const errors = []
  for (const [kind, name] of [
    ['container', resources.containerName],
    ['volume', resources.volumeName]
  ]) {
    try {
      await removeOwnedResource({ kind, name, runId: resources.runId })
    } catch (error) {
      errors.push(error)
    }
  }
  const hasTeardownErrors = errors.length > 0
  if (hasTeardownErrors) {
    throw new AggregateError(errors, 'Database test teardown failed')
  }
}

export async function assertResourcesAbsent(runId) {
  validateRunId(runId)
  const suffix = runId.slice(0, 48)
  assert.equal(await inspectOwnership({ kind: 'container', name: `ldb-db-${suffix}` }), undefined)
  assert.equal(await inspectOwnership({ kind: 'volume', name: `ldb-db-${suffix}` }), undefined)
}
