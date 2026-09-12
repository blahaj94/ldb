import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createFixtureRoot, fixturePath, cleanupFixture } from './isolation.mjs'

const parents = []

async function parentDirectory() {
  const parent = await mkdtemp(join(tmpdir(), 'ldb-synthetic-isolation-'))
  parents.push(parent)
  return parent
}

afterEach(async () => {
  for (const parent of parents.splice(0)) {
    await rm(parent, { recursive: true, force: true })
  }
})

it('creates an exclusive root and manifest without replacing existing evidence', async () => {
  const parent = await parentDirectory()
  const fixture = await createFixtureRoot(parent)
  const manifest = await readFile(fixture.manifest, 'utf8')
  const second = await createFixtureRoot(parent)

  expect(second.root).not.toBe(fixture.root)
  expect(await readFile(fixture.manifest, 'utf8')).toBe(manifest)
  expect(JSON.parse(manifest)).toEqual({ version: 1, root: fixture.name, nonce: fixture.nonce })
  expect(await cleanupFixture(fixture)).toBe('clean')
  expect(await cleanupFixture(second)).toBe('clean')
  expect(await readdir(parent)).toEqual([])
})

it('rejects relative parents and paths escaping the owned root', async () => {
  await expect(createFixtureRoot('relative')).rejects.toThrow('absolute')
  const fixture = await createFixtureRoot(await parentDirectory())

  expect(() => fixturePath(fixture, '..', 'sentinel')).toThrow('containment')
  expect(() => fixturePath(fixture, fixture.root)).toThrow('relative')
  expect(() => fixturePath(fixture, '.')).toThrow('containment')
})

it('removes a junction itself while preserving its target sentinel', async () => {
  const parent = await parentDirectory()
  const target = join(parent, 'target')
  await mkdir(target)
  await writeFile(join(target, 'sentinel'), 'synthetic sentinel', { flag: 'wx' })
  const fixture = await createFixtureRoot(parent)
  await symlink(target, fixturePath(fixture, 'junction'), 'junction')

  expect(await cleanupFixture(fixture)).toBe('clean')
  expect(await readFile(join(target, 'sentinel'), 'utf8')).toBe('synthetic sentinel')
})

it('rejects a parent reached through a junction before creating evidence', async () => {
  const parent = await parentDirectory()
  const target = join(parent, 'target')
  const junction = join(parent, 'junction')
  await mkdir(target)
  await symlink(target, junction, 'junction')

  await expect(createFixtureRoot(junction)).rejects.toThrow('reparse')
  expect(await readdir(target)).toEqual([])
})

it('preserves the manifest and files when cleanup ownership is uncertain', async () => {
  const fixture = await createFixtureRoot(await parentDirectory())
  const sentinel = fixturePath(fixture, 'sentinel')
  await writeFile(sentinel, 'synthetic sentinel', { flag: 'wx' })
  await writeFile(fixture.manifest, '{"version":0}')

  expect(await cleanupFixture(fixture)).toBe('cleanup-incomplete')
  expect(await readFile(sentinel, 'utf8')).toBe('synthetic sentinel')
  expect(await readFile(fixture.manifest, 'utf8')).toBe('{"version":0}')
})

it('preserves evidence when resources have not been confirmed released', async () => {
  const fixture = await createFixtureRoot(await parentDirectory())

  expect(await cleanupFixture(fixture, { resourcesReleased: false })).toBe('cleanup-incomplete')
  expect(await readdir(fixture.root)).toEqual([])
  expect(await readFile(fixture.manifest, 'utf8')).toContain(fixture.nonce)
})
