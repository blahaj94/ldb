import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DataSource } from 'typeorm'

type MigrationQuery = { query: string; parameters?: unknown[] }

function renderQueryStatements(queries: MigrationQuery[]): string {
  const queryStatements = queries
    .map(({ query, parameters }) => {
      const serializedQuery = JSON.stringify(query)
      const hasParameters = parameters !== undefined
      const parameterArgument = hasParameters ? `, ${JSON.stringify(parameters)}` : ''
      const queryStatement = `    await queryRunner.query(${serializedQuery}${parameterArgument})`
      return queryStatement
    })
    .join('\n')
  return queryStatements
}

function renderMigrationSource({
  className,
  upQueries,
  downQueries
}: {
  className: string
  upQueries: MigrationQuery[]
  downQueries: MigrationQuery[]
}): string {
  const upStatements = renderQueryStatements(upQueries)
  const downStatements = renderQueryStatements([...downQueries].reverse())
  const migrationSource = `import type { MigrationInterface, QueryRunner } from 'typeorm'

export class ${className} implements MigrationInterface {
  readonly name = '${className}'

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) throw new Error('Auth schema Migration requires an active transaction')
${upStatements}
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) throw new Error('Auth schema Migration requires an active transaction')
${downStatements}
  }
}
`
  return migrationSource
}

// TypeORM의 schema diff를 사용하되, TS type import와 정제된 오류 출력은 기존 ESM 계약에 맞춘다.
export async function generateMigration(
  name: string,
  createDataSource: () => DataSource,
  directory: string
): Promise<string> {
  let dataSource: DataSource | undefined
  try {
    const isMigrationNameValid = /^[A-Z][A-Za-z0-9]{0,79}$/.test(name)
    if (!isMigrationNameValid) {
      throw new Error('Invalid migration name')
    }
    dataSource = createDataSource()
    await dataSource.initialize()
    const { upQueries, downQueries } = await dataSource.driver.createSchemaBuilder().log()
    await dataSource.destroy()
    const hasNoSchemaChanges = upQueries.length === 0
    if (hasNoSchemaChanges) {
      return 'Database schema is current'
    }
    const timestamp = Date.now()
    const className = `${name}${timestamp}`
    const content = renderMigrationSource({ className, upQueries, downQueries })
    const filename = `${timestamp}-${name}.ts`
    await writeFile(join(directory, filename), content, { flag: 'wx' })
    return `Database migration generated: ${filename}`
  } catch {
    const dataSourceToClose = dataSource
    const hasDataSource = dataSourceToClose != null
    const isDataSourceInitialized = hasDataSource && dataSourceToClose.isInitialized
    if (isDataSourceInitialized) {
      try {
        await dataSourceToClose.destroy()
      } catch {
        /* 정제된 동일 오류로 처리한다. */
      }
    }
    const error = new Error('Database migration generation failed')
    error.stack = `${error.name}: ${error.message}`
    throw error
  }
}
