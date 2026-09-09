import type { DataSource } from 'typeorm'
import {
  createDatabaseDataSource,
  readDatabaseConfiguration,
  runMigrationCommand
} from './index.js'

const command = process.argv[2]

function isMigrationCommand(value: string | undefined): value is 'up' | 'down' | 'show' {
  const isUpCommand = value === 'up'
  const isDownCommand = value === 'down'
  const isShowCommand = value === 'show'
  const isSupportedCommand = isUpCommand || isDownCommand || isShowCommand
  return isSupportedCommand
}

try {
  const isCommandSupported = isMigrationCommand(command)
  if (!isCommandSupported) {
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
