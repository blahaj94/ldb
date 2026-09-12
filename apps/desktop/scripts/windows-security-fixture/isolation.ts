import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

type ReparseInspection = (path: string) => boolean
type Fixture = {
  parent: string
  root: string
  manifest: string
  name: string
  nonce: string
  inspectReparse?: ReparseInspection
}

async function assertPlainAncestors(
  path: string,
  inspectReparse?: ReparseInspection
): Promise<void> {
  let current = path
  for (;;) {
    const information = await lstat(current)
    const isReparse = information.isSymbolicLink()
    const isDirectory = information.isDirectory()
    if (isReparse || !isDirectory) {
      throw new Error('Fixture ancestor is reparse or not a directory.')
    }
    const hasNativeInspection = inspectReparse != null
    if (hasNativeInspection && inspectReparse(current)) {
      throw new Error('Fixture ancestor is reparse.')
    }
    const parent = dirname(current)
    const isVolumeRoot = parent === current
    if (isVolumeRoot) {
      return
    }
    current = parent
  }
}

export function fixturePath(fixture: Pick<Fixture, 'root'>, ...parts: string[]): string {
  const hasAbsolutePart = parts.some((part) => isAbsolute(part))
  if (hasAbsolutePart) {
    throw new Error('Fixture children must be relative.')
  }
  const destination = resolve(fixture.root, ...parts)
  const child = relative(fixture.root, destination)
  const isRoot = child === ''
  const isOutside = child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)
  if (isRoot || isOutside) {
    throw new Error('Fixture path containment failed.')
  }
  return destination
}

export async function createFixtureRoot(
  parent: string,
  options: { inspectReparse?: ReparseInspection } = {}
): Promise<Fixture> {
  const { inspectReparse } = options
  const isParentAbsolute = isAbsolute(parent)
  if (!isParentAbsolute) {
    throw new Error('Fixture parent must be absolute.')
  }
  const resolvedParent = resolve(parent)
  await assertPlainAncestors(resolvedParent, inspectReparse)
  const name = `windows-synthetic-${randomUUID()}`
  const nonce = randomUUID()
  const root = join(resolvedParent, name)
  const manifest = join(resolvedParent, `${name}.manifest.json`)
  const fixture = { parent: resolvedParent, root, manifest, name, nonce, inspectReparse }
  const body = JSON.stringify({ version: 1, root: name, nonce })

  // Keep evidence outside the root so a partial cleanup cannot delete it.
  await writeFile(manifest, body, { flag: 'wx' })
  await mkdir(root)
  return fixture
}

async function removeChildren(root: string, inspectReparse?: ReparseInspection): Promise<void> {
  const entries = await readdir(root)
  for (const name of entries) {
    const child = fixturePath({ root }, name)
    const information = await lstat(child)
    const isLink = information.isSymbolicLink()
    if (isLink) {
      await unlink(child)
      continue
    }
    const hasNativeInspection = inspectReparse != null
    if (hasNativeInspection && inspectReparse(child)) {
      // An unfamiliar reparse type is not traversed or guessed at during cleanup.
      throw new Error('Fixture cleanup found an unsupported reparse point.')
    }
    const isDirectory = information.isDirectory()
    if (isDirectory) {
      await removeChildren(child, inspectReparse)
      await rmdir(child)
      continue
    }
    const isFile = information.isFile()
    if (!isFile) {
      throw new Error('Fixture cleanup found an unsupported file type.')
    }
    await unlink(child)
  }
}

export async function cleanupFixture(
  fixture: Fixture,
  { resourcesReleased = true } = {}
): Promise<'clean' | 'cleanup-incomplete'> {
  if (!resourcesReleased) {
    return 'cleanup-incomplete'
  }
  try {
    await assertPlainAncestors(fixture.parent, fixture.inspectReparse)
    const expectedRoot = join(fixture.parent, fixture.name)
    const expectedManifest = `${expectedRoot}.manifest.json`
    const hasExpectedPaths = fixture.root === expectedRoot && fixture.manifest === expectedManifest
    const hasOwnedName = /^windows-synthetic-[0-9a-f-]{36}$/.test(fixture.name)
    if (!hasExpectedPaths || !hasOwnedName) {
      return 'cleanup-incomplete'
    }
    const manifestInformation = await lstat(fixture.manifest)
    const isManifestFile = manifestInformation.isFile() && !manifestInformation.isSymbolicLink()
    if (!isManifestFile) {
      return 'cleanup-incomplete'
    }
    const manifest = JSON.parse(await readFile(fixture.manifest, 'utf8'))
    const isOwned =
      manifest.version === 1 && manifest.root === fixture.name && manifest.nonce === fixture.nonce
    if (!isOwned) {
      return 'cleanup-incomplete'
    }
    await assertPlainAncestors(fixture.root, fixture.inspectReparse)
    await removeChildren(fixture.root, fixture.inspectReparse)
    await rmdir(fixture.root)
    const remaining = await readdir(fixture.parent)
    const rootRemains = remaining.includes(fixture.name)
    if (rootRemains) {
      return 'cleanup-incomplete'
    }
    await unlink(fixture.manifest)
    return 'clean'
  } catch {
    return 'cleanup-incomplete'
  }
}
