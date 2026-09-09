import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { DataSource, EntitySchema } from 'typeorm'
import { createDatabaseDataSource, createDatabaseOptions } from '../dist/database/index.js'
import { generateMigration } from '../dist/database/generate.js'
import { authSchemas } from '../dist/database/schemas/index.js'
import { UserSchema } from '../dist/database/schemas/users.js'
import { AuthSessionSchema } from '../dist/database/schemas/auth-sessions.js'
import { AuthRefreshTokenSchema } from '../dist/database/schemas/auth-refresh-tokens.js'
import { AuthLoginRequestSchema } from '../dist/database/schemas/auth-login-requests.js'
import { assertLoginRequestStateMatrix } from './auth-login-request-contract.mjs'
import {
  assertConstraintBehavior,
  assertSchema,
  databaseSnapshot,
  withDataSource
} from './database-contract.mjs'

async function compileGenerated(directory) {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.ts'))
  assert.equal(files.length, 1)
  const content = await readFile(join(directory, files[0]), 'utf8')
  const { outputText } = ts.transpileModule(content, {
    compilerOptions: { module: ts.ModuleKind.ESNext }
  })
  const path = join(directory, 'migration.mjs')
  await writeFile(path, outputText)
  return Object.values(await import(pathToFileURL(path).href))[0]
}

async function constraintDefinitions(dataSource) {
  const constraintDefinitionsSql = `
    SELECT t.relname, c.conname, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname <> 'typeorm_migrations' AND c.contype IN ('p','u','f','c')
    ORDER BY t.relname, c.conname
  `
  return await dataSource.query(constraintDefinitionsSql)
}

async function assertOrmRoundTrip(dataSource) {
  const runner = dataSource.createQueryRunner()
  await runner.connect()
  await runner.startTransaction()
  try {
    const users = runner.manager.getRepository(UserSchema)
    const sessions = runner.manager.getRepository(AuthSessionSchema)
    const tokens = runner.manager.getRepository(AuthRefreshTokenSchema)
    const logins = runner.manager.getRepository(AuthLoginRequestSchema)
    const now = new Date('2026-09-06T00:00:00Z')
    const user = {
      id: randomUUID(),
      provider: 'google',
      providerSubject: 'Opaque:CaseSensitive',
      nickname: '테스트',
      createdAt: now
    }
    await users.insert(user)
    assert.deepEqual(await users.findOneByOrFail({ id: user.id }), user)
    const session = {
      id: randomUUID(),
      userId: user.id,
      createdAt: now,
      lastActiveAt: now,
      revokedAt: null,
      revokedReason: null
    }
    await sessions.insert(session)
    assert.deepEqual(await sessions.findOneByOrFail({ id: session.id }), session)
    const token = {
      tokenHash: Buffer.alloc(32, 7),
      sessionId: session.id,
      issuedAt: now,
      consumedAt: null
    }
    await tokens.insert(token)
    assert.deepEqual(await tokens.findOneByOrFail({ tokenHash: token.tokenHash }), token)
    const id = randomUUID()
    await logins.insert({
      id,
      purpose: 'login',
      provider: 'google',
      clientId: 'desktop',
      providerConfigVersion: 'test',
      returnTargetId: 'test',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      status: 'failed'
    })
    const login = await logins.findOneByOrFail({ id })
    assert.equal(login.codeChallenge, null)
    assert.equal(login.verifiedSubject, null)
    assert.equal(login.clientId, 'desktop')
    await users.delete({ id: user.id })
    assert.equal(await sessions.countBy({ id: session.id }), 0)
    assert.equal(await tokens.countBy({ sessionId: session.id }), 0)
  } finally {
    await runner.rollbackTransaction()
    await runner.release()
  }
}

export async function assertSchemaFirst(configuration, mark) {
  const directory = await mkdtemp(join(tmpdir(), 'ldb-schema-first-'))
  const generatedConfiguration = { ...configuration, database: 'ldb_schema_first_test' }
  let created = false
  try {
    const originalDefinitions = await withDataSource(
      createDatabaseDataSource,
      configuration,
      async (source) => {
        mark('existing migration drift')
        assert.deepEqual((await source.driver.createSchemaBuilder().log()).upQueries, [])
        await assertOrmRoundTrip(source)
        await source.query('CREATE DATABASE ldb_schema_first_test')
        created = true
        return await constraintDefinitions(source)
      }
    )
    mark('initial generation')
    const initialDirectory = await mkdtemp(join(directory, 'initial-'))
    const sourceFactory = () => createDatabaseDataSource(generatedConfiguration)
    const before = await withDataSource(sourceFactory, generatedConfiguration, databaseSnapshot)
    assert.match(
      await generateMigration('GeneratedAuth', sourceFactory, initialDirectory),
      /generated:/
    )
    assert.deepEqual(
      await withDataSource(sourceFactory, generatedConfiguration, databaseSnapshot),
      before
    )
    const Initial = await compileGenerated(initialDirectory)
    const initialFactory = () =>
      new DataSource({ ...createDatabaseOptions(generatedConfiguration), migrations: [Initial] })
    await withDataSource(initialFactory, generatedConfiguration, async (source) => {
      mark('generated apply and constraints')
      assert.equal((await source.runMigrations()).length, 1)
      await assertSchema(source, mark, [new Initial().name])
      assert.deepEqual(await constraintDefinitions(source), originalDefinitions)
      await assertConstraintBehavior(source)
      await assertLoginRequestStateMatrix(source)
      await assertOrmRoundTrip(source)
    })
    assert.equal(
      await generateMigration('NoChanges', sourceFactory, directory),
      'Database schema is current'
    )

    // Product schema를 바꾸지 않는 임시 metadata로 이후 개발 흐름까지 실행한다.
    const changedUser = new EntitySchema({
      ...UserSchema.options,
      columns: {
        ...UserSchema.options.columns,
        migrationProbe: { name: 'migration_probe', type: 'text', nullable: true }
      }
    })
    const entities = authSchemas.map((schema) => (schema === UserSchema ? changedUser : schema))
    const changedFactory = () =>
      new DataSource({
        ...createDatabaseOptions(generatedConfiguration),
        entities,
        migrations: [Initial]
      })
    mark('subsequent generation')
    const nextDirectory = await mkdtemp(join(directory, 'next-'))
    assert.match(await generateMigration('AddProbe', changedFactory, nextDirectory), /generated:/)
    await compileGenerated(nextDirectory)
    const nextFactory = () =>
      new DataSource({
        ...createDatabaseOptions(generatedConfiguration),
        entities,
        migrations: [join(directory, '*/migration.mjs')]
      })
    await withDataSource(nextFactory, generatedConfiguration, async (source) => {
      mark('subsequent apply and rollback')
      assert.equal((await source.runMigrations()).length, 1)
      assert.deepEqual((await source.driver.createSchemaBuilder().log()).upQueries, [])
      await source.query('SELECT migration_probe FROM users')
      await source.undoLastMigration()
      const hasPendingSchemaChanges =
        (await source.driver.createSchemaBuilder().log()).upQueries.length > 0
      assert(hasPendingSchemaChanges)
      await assertSchema(source, mark, [new Initial().name])
      await source.undoLastMigration()
      assert.deepEqual(
        (await databaseSnapshot(source)).relations.map(({ name }) => name),
        ['typeorm_migrations']
      )
      assert.deepEqual(await source.query('SELECT name FROM typeorm_migrations'), [])
    })
  } finally {
    try {
      if (created) {
        await withDataSource(createDatabaseDataSource, configuration, (source) =>
          source.query('DROP DATABASE ldb_schema_first_test')
        )
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
