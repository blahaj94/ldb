import assert from 'node:assert/strict'
import test from 'node:test'
import { EntitySchema } from 'typeorm'
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
  readDatabaseConfiguration(env: NodeJS.ProcessEnv): DatabaseConfiguration
  createNestDatabaseOptions(configuration: DatabaseConfiguration): DataSourceOptions & {
    retryAttempts: number
    verboseRetryLog: boolean
    toRetry(error: unknown): boolean
  }
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

test('database options discover compiled migrations without automatic schema changes', async () => {
  const { createDatabaseOptions } = await loadDatabaseModule()
  const options = createDatabaseOptions(configuration)

  assert.equal(options.type, 'postgres')
  assert.equal(options.synchronize, false)
  assert.equal(options.migrationsRun, false)
  assert.equal(options.logging, false)
  assert.equal(options.migrationsTransactionMode, 'all')
  assert.equal(options.migrationsTableName, 'typeorm_migrations')
  assert(Array.isArray(options.migrations))
  assert.match(String(options.migrations[0]), /\/database\/migrations\/\*\.js$/)
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

test('database configuration accepts only complete discrete connection fields', async () => {
  const { readDatabaseConfiguration } = await loadDatabaseModule()
  assert.deepEqual(
    readDatabaseConfiguration({
      DB_HOST: '127.0.0.1',
      DB_PORT: '5432',
      DB_USERNAME: 'user',
      DB_PASSWORD: 'password',
      DB_NAME: 'database',
    }),
    {
      host: '127.0.0.1',
      port: 5432,
      username: 'user',
      password: 'password',
      database: 'database',
    },
  )

  for (const env of [
    {},
    { DB_HOST: '', DB_PORT: '5432', DB_USERNAME: 'user', DB_PASSWORD: 'secret', DB_NAME: 'db' },
    { DB_HOST: 'host', DB_PORT: '+5432', DB_USERNAME: 'user', DB_PASSWORD: 'secret', DB_NAME: 'db' },
    { DB_HOST: 'host', DB_PORT: '0', DB_USERNAME: 'user', DB_PASSWORD: 'secret', DB_NAME: 'db' },
  ]) {
    assert.throws(() => readDatabaseConfiguration(env), (error: unknown) => {
      assert(error instanceof Error)
      assert.equal(error.message, 'Invalid database configuration')
      assert.equal(error.message.includes('secret'), false)
      return true
    })
  }
})

test('Nest lifecycle disables retry logging and automatic schema changes', async () => {
  const { createNestDatabaseOptions } = await loadDatabaseModule()
  const options = createNestDatabaseOptions(configuration)

  assert.equal(options.synchronize, false)
  assert.equal(options.migrationsRun, false)
  assert.equal(options.logging, false)
  assert.equal(options.retryAttempts, 1)
  assert.equal(options.verboseRetryLog, false)
  assert.equal(options.toRetry(new Error('secret database detail')), false)
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

test('migration command sanitizes configuration factory failures', async () => {
  const { runMigrationCommand } = await loadDatabaseModule()

  await assert.rejects(
    runMigrationCommand('up', () => {
      throw new Error('secret configuration value')
    }),
    (error: unknown) => {
      assert(error instanceof Error)
      assert.equal(error.message, 'Database migration failed')
      assert.equal(error.stack?.includes('secret configuration value'), false)
      return true
    },
  )
})

test('migration status reads metadata without asking TypeORM to create its history table', async () => {
  const { runMigrationCommand } = await loadDatabaseModule()
  const queries: string[] = []
  const fakeDataSource = {
    isInitialized: false,
    initialize: async () => {
      fakeDataSource.isInitialized = true
      return fakeDataSource
    },
    query: async (sql: string) => {
      queries.push(sql)
      return [{ exists: false }]
    },
    showMigrations: async () => assert.fail('showMigrations creates the history table on a fresh database'),
    destroy: async () => {
      fakeDataSource.isInitialized = false
    },
  }

  const result = await runMigrationCommand('show', () => fakeDataSource as unknown as DataSource)

  assert.equal(result, 'Database migrations pending')
  assert.deepEqual(queries, ["SELECT to_regclass('public.typeorm_migrations') IS NOT NULL AS exists"])
})

test('database options register four typed schemas before migrations are generated', async () => {
  const { createDatabaseOptions } = await loadDatabaseModule()
  const options = createDatabaseOptions(configuration)
  assert(Array.isArray(options.entities))
  assert.deepEqual(options.entities.map((schema) => { assert(schema instanceof EntitySchema); return schema.options.tableName }).sort(), [
    'auth_login_requests', 'auth_refresh_tokens', 'auth_sessions', 'users',
  ])
})

test('migration status reports a newly registered migration as pending', async () => {
  const { runMigrationCommand, initialAuthSchema } = await loadDatabaseModule()
  const source = {
    isInitialized: false,
    migrations: [new initialAuthSchema(), { name: 'NextMigration1788690000000' }],
    initialize: async () => { source.isInitialized = true },
    query: async (sql: string) => sql.includes('to_regclass')
      ? [{ exists: true }]
      : [{ name: new initialAuthSchema().name }],
    destroy: async () => { source.isInitialized = false },
  }
  assert.equal(await runMigrationCommand('show', () => source as unknown as DataSource), 'Database migrations pending')
})
