import type { DataSource } from 'typeorm'
import {
  createDatabaseDataSource,
  readDatabaseConfiguration,
  runMigrationCommand
} from './index.js'

const command = process.argv[2]

function isMigrationCommand(value: string | undefined): value is 'up' | 'down' | 'show' {
  return value === 'up' || value === 'down' || value === 'show'
}

try {
  if (!isMigrationCommand(command)) {
    throw new Error('Database migration failed')
  }
  const result = await runMigrationCommand(command, (): DataSource => {
    return createDatabaseDataSource(readDatabaseConfiguration(process.env))
  })
  process.stdout.write(`${result}\n`)
} catch {
  process.stderr.write('Database migration failed\n')
  process.exitCode = 1
}
