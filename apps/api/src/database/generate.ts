import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DataSource } from 'typeorm'

// TypeORM의 schema diff를 사용하되, TS type import와 정제된 오류 출력은 기존 ESM 계약에 맞춘다.
export async function generateMigration(
  name: string,
  createDataSource: () => DataSource,
  directory: string
): Promise<string> {
  let dataSource: DataSource | undefined
  try {
    if (!/^[A-Z][A-Za-z0-9]{0,79}$/.test(name)) {
      throw new Error('Invalid migration name')
    }
    dataSource = createDataSource()
    await dataSource.initialize()
    const { upQueries, downQueries } = await dataSource.driver.createSchemaBuilder().log()
    await dataSource.destroy()
    if (upQueries.length === 0) {
      return 'Database schema is current'
    }
    const timestamp = Date.now()
    const className = `${name}${timestamp}`
    const statements = (queries: typeof upQueries) =>
      queries
        .map(
          ({ query, parameters }) =>
            `    await queryRunner.query(${JSON.stringify(query)}${parameters === undefined ? '' : `, ${JSON.stringify(parameters)}`})`
        )
        .join('\n')
    const content = `import type { MigrationInterface, QueryRunner } from 'typeorm'

export class ${className} implements MigrationInterface {
  readonly name = '${className}'

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) throw new Error('Auth schema Migration requires an active transaction')
${statements(upQueries)}
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) throw new Error('Auth schema Migration requires an active transaction')
${statements([...downQueries].reverse())}
  }
}
`
    const filename = `${timestamp}-${name}.ts`
    await writeFile(join(directory, filename), content, { flag: 'wx' })
    return `Database migration generated: ${filename}`
  } catch {
    if (dataSource?.isInitialized) {
      try {
        await dataSource.destroy()
      } catch {
        /* 정제된 동일 오류로 처리한다. */
      }
    }
    const error = new Error('Database migration generation failed')
    error.stack = `${error.name}: ${error.message}`
    throw error
  }
}
