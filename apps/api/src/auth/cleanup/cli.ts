import { createDatabaseDataSource, readDatabaseConfiguration } from '../../database/index.js'
import { runAuthenticationCleanup } from './command.js'

try {
  await runAuthenticationCleanup(() => createDatabaseDataSource(readDatabaseConfiguration(process.env)))
  process.stdout.write('Authentication cleanup completed\n')
} catch {
  process.stderr.write('Authentication cleanup failed\n')
  process.exitCode = 1
}
