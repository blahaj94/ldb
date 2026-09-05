import assert from 'node:assert/strict'
import test from 'node:test'
import type { DataSource, DataSourceOptions, MigrationInterface } from 'typeorm'

interface DatabaseConfiguration {
  host: string
  port: number
  username: string
  password: string
  database: string
}

interface DatabaseModuleExports {
  createDatabaseDataSource(configuration: DatabaseConfiguration): DataSource
  createDatabaseOptions(configuration: DatabaseConfiguration): DataSourceOptions
  initialAuthSchema: new () => MigrationInterface
  runMigrationCommand(
    command: 'up' | 'down' | 'show',
    createDataSource: () => DataSource,
  ): Promise<string>
}

async function loadDatabaseModule(): Promise<DatabaseModuleExports> {
  const moduleUrl = new URL('../src/database/index.js', import.meta.url)
  return (await import(moduleUrl.href)) as DatabaseModuleExports
}

const configuration: DatabaseConfiguration = {
  host: '127.0.0.1',
  port: 5432,
  username: 'test-user',
  password: 'test-password',
  database: 'test-database',
}

test('database options register one explicit migration without automatic schema changes', async () => {
  const { createDatabaseOptions, initialAuthSchema } = await loadDatabaseModule()
  const options = createDatabaseOptions(configuration)

  assert.equal(options.type, 'postgres')
  assert.equal(options.synchronize, false)
  assert.equal(options.migrationsRun, false)
  assert.equal(options.logging, false)
  assert.equal(options.migrationsTransactionMode, 'all')
  assert.equal(options.migrationsTableName, 'typeorm_migrations')
  assert.deepEqual(options.migrations, [initialAuthSchema])
  assert.deepEqual(
    {
      host: options.host,
      port: options.port,
      username: options.username,
      password: options.password,
      database: options.database,
    },
    configuration,
  )
})

test('database factory returns an uninitialized TypeORM data source', async () => {
  const { createDatabaseDataSource } = await loadDatabaseModule()
  const dataSource = createDatabaseDataSource(configuration)

  assert.equal(dataSource.isInitialized, false)
  assert.equal(dataSource.options.type, 'postgres')
})

test('migration command uses one all-migrations transaction and always destroys its connection', async () => {
  const { runMigrationCommand } = await loadDatabaseModule()
  const calls: string[] = []
  let initialized = false
  const fakeDataSource = {
    get isInitialized() {
      return initialized
    },
    initialize: async () => {
      calls.push('initialize')
      initialized = true
      return fakeDataSource
    },
    runMigrations: async (options?: { transaction?: 'all' | 'none' | 'each' }) => {
      calls.push(`up:${options?.transaction}`)
      return [{ name: 'InitialAuthSchema' }]
    },
    destroy: async () => {
      calls.push('destroy')
      initialized = false
    },
  }
  const dataSource = fakeDataSource as unknown as DataSource

  const result = await runMigrationCommand('up', () => dataSource)

  assert.equal(result, 'Database migration applied: 1')
  assert.deepEqual(calls, ['initialize', 'up:all', 'destroy'])
})

test('migration command destroys its connection after a database failure', async () => {
  const { runMigrationCommand } = await loadDatabaseModule()
  const rawError = new Error('postgres://secret-user:secret-password@127.0.0.1/private')
  let destroyed = false
  let initialized = false
  const fakeDataSource = {
    get isInitialized() {
      return initialized
    },
    initialize: async () => {
      initialized = true
      throw rawError
    },
    destroy: async () => {
      destroyed = true
      initialized = false
    },
  }
  const dataSource = fakeDataSource as unknown as DataSource

  await assert.rejects(runMigrationCommand('up', () => dataSource), (error: unknown) => {
    assert(error instanceof Error)
    assert.equal(error.message, 'Database migration failed')
    assert.equal(error.cause, undefined)
    assert.equal(error.stack?.includes(rawError.message), false)
    return true
  })
  assert.equal(destroyed, true)
})
