import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import type { DataSource } from 'typeorm'

async function generator() {
  return await import(new URL('../src/database/generate.js', import.meta.url).href) as {
    generateMigration(name: string, factory: () => DataSource, directory: string): Promise<string>
  }
}

test('Schema First generation writes executable ESM-safe SQL and reverses rollback order without applying it', async () => {
  const { generateMigration } = await generator()
  const directory = await mkdtemp(join(tmpdir(), 'ldb-generation-'))
  const sql = 'COMMENT ON TABLE users IS \'` ${globalThis.unexpected = true} \\\\ sample\''
  const calls: string[] = []
  const source = {
    isInitialized: false,
    initialize: async () => { source.isInitialized = true; calls.push('connect') },
    driver: { createSchemaBuilder: () => ({ log: async () => ({
      upQueries: [{ query: sql, parameters: [] }],
      downQueries: [{ query: 'first', parameters: [1] }, { query: 'second' }],
    }) }) },
    destroy: async () => { source.isInitialized = false; calls.push('disconnect') },
  }
  try {
    const result = await generateMigration('AddExample', () => source as unknown as DataSource, directory)
    assert.match(result, /Database migration generated:/)
    assert.deepEqual(calls, ['connect', 'disconnect'])
    const files = await readdir(directory)
    assert.equal(files.length, 1)
    const text = await readFile(join(directory, files[0]), 'utf8')
    assert.match(text, /^import type /)
    const compiled = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
    const output = join(directory, 'migration.mjs')
    await writeFile(output, compiled)
    const module = await import(pathToFileURL(output).href)
    const Migration = Object.values(module)[0] as new () => {
      up(runner: unknown): Promise<void>
      down(runner: unknown): Promise<void>
    }
    const executed: unknown[] = []
    const runner = { isTransactionActive: true, query: async (...args: unknown[]) => { executed.push(args) } }
    await new Migration().up(runner)
    assert.deepEqual(executed, [[sql, []]])
    executed.length = 0
    await new Migration().down(runner)
    assert.deepEqual(executed, [['second'], ['first', [1]]])
    await assert.rejects(new Migration().up({ ...runner, isTransactionActive: false }), /active transaction/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('generation rejects unsafe names, reports no changes and sanitizes connection failures', async () => {
  const { generateMigration } = await generator()
  const directory = await mkdtemp(join(tmpdir(), 'ldb-generation-'))
  const source = {
    isInitialized: false,
    initialize: async () => { source.isInitialized = true },
    driver: { createSchemaBuilder: () => ({ log: async () => ({ upQueries: [], downQueries: [] }) }) },
    destroy: async () => { source.isInitialized = false },
  }
  try {
    assert.equal(await generateMigration('NoChanges', () => source as unknown as DataSource, directory), 'Database schema is current')
    assert.deepEqual(await readdir(directory), [])
    await assert.rejects(generateMigration('../Escape', () => source as unknown as DataSource, directory))
    await assert.rejects(generateMigration('Failure', () => {
      throw new Error('secret connection value')
    }, directory), (error: unknown) => {
      assert(error instanceof Error)
      assert.equal(error.message, 'Database migration generation failed')
      assert.equal(error.stack?.includes('secret connection value'), false)
      return true
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
