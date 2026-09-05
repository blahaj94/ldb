import { fileURLToPath } from 'node:url'
import { createDatabaseDataSource, readDatabaseConfiguration } from './index.js'
import { generateMigration } from './generate.js'

try {
  const result = await generateMigration(
    process.argv[2] ?? '',
    () => createDatabaseDataSource(readDatabaseConfiguration(process.env)),
    fileURLToPath(new URL('../../src/database/migrations/', import.meta.url)),
  )
  process.stdout.write(`${result}\n`)
} catch {
  process.stderr.write('Database migration generation failed\n')
  process.exitCode = 1
}
