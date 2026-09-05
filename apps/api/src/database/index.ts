import { fileURLToPath } from 'node:url'
import { Module } from '@nestjs/common'
import type { DynamicModule } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import type { TypeOrmModuleOptions } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import type { DataSourceOptions } from 'typeorm'
import type { DatabaseConfiguration } from './configuration.js'
import { InitialAuthSchema1788600000000 } from './migrations/1788600000000-initial-auth-schema.js'

import { authSchemas } from './schemas/index.js'

export { readDatabaseConfiguration } from './configuration.js'
export type { DatabaseConfiguration } from './configuration.js'

export const initialAuthSchema = InitialAuthSchema1788600000000

export function createDatabaseOptions(configuration: DatabaseConfiguration): DataSourceOptions {
  return {
    type: 'postgres',
    ...configuration,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    migrationsTransactionMode: 'all',
    migrationsTableName: 'typeorm_migrations',
    entities: authSchemas,
    migrations: [fileURLToPath(new URL('./migrations/*.js', import.meta.url))],
  }
}

export function createDatabaseDataSource(configuration: DatabaseConfiguration): DataSource {
  return new DataSource(createDatabaseOptions(configuration))
}

export function createNestDatabaseOptions(configuration: DatabaseConfiguration): TypeOrmModuleOptions {
  return {
    ...createDatabaseOptions(configuration),
    retryAttempts: 1,
    verboseRetryLog: false,
    toRetry: () => false,
  }
}

@Module({})
export class DatabaseModule {
  static register(configuration: DatabaseConfiguration): DynamicModule {
    return {
      module: DatabaseModule,
      imports: [TypeOrmModule.forRoot(createNestDatabaseOptions(configuration))],
      exports: [TypeOrmModule],
    }
  }
}

type MigrationCommand = 'up' | 'down' | 'show'

function sanitizeMigrationError(): Error {
  const error = new Error('Database migration failed')
  error.stack = `${error.name}: ${error.message}`
  return error
}

export async function runMigrationCommand(
  command: MigrationCommand,
  createDataSource: () => DataSource,
): Promise<string> {
  let dataSource: DataSource | undefined
  let result: string | undefined
  let failed = false
  try {
    dataSource = createDataSource()
    await dataSource.initialize()
    if (command === 'up') {
      const applied = await dataSource.runMigrations({ transaction: 'all' })
      result = `Database migration applied: ${applied.length}`
    } else if (command === 'down') {
      await dataSource.undoLastMigration({ transaction: 'all' })
      result = 'Database migration reverted'
    } else {
      const relation = (await dataSource.query(
        "SELECT to_regclass('public.typeorm_migrations') IS NOT NULL AS exists",
      )) as Array<{ exists: boolean }>
      if (!relation[0]?.exists) {
        result = 'Database migrations pending'
      } else {
        const history = (await dataSource.query(
          'SELECT name FROM "typeorm_migrations"',
        )) as Array<{ name: string }>
        const applied = new Set(history.map(({ name }) => name))
        result = dataSource.migrations.every((migration) => applied.has(migration.name ?? migration.constructor.name))
          ? 'Database migrations current' : 'Database migrations pending'
      }
    }
  } catch {
    failed = true
  }
  if (dataSource?.isInitialized) {
    try {
      await dataSource.destroy()
    } catch {
      failed = true
    }
  }
  if (failed || result === undefined) throw sanitizeMigrationError()
  return result
}
