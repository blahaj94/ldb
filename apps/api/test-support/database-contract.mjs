import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { setTimeout as delay } from 'node:timers/promises'

export const DOMAIN_TABLES = [
  'auth_login_requests',
  'auth_refresh_tokens',
  'auth_sessions',
  'users'
]
export const MIGRATIONS_TABLE = 'typeorm_migrations'

export async function withDataSource(createDataSource, configuration, operation) {
  const dataSource = createDataSource(configuration)
  try {
    await dataSource.initialize()
    return await operation(dataSource)
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy()
    }
  }
}

export async function waitForAuthenticatedReadiness(
  createDataSource,
  configuration,
  timeoutMs = 20_000
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const attemptTimeoutMs = Math.max(1, Math.min(500, deadline - Date.now()))
    try {
      return await withDataSource(
        (candidate) => createDataSource(candidate, attemptTimeoutMs),
        configuration,
        async (dataSource) => {
          const result = await dataSource.query('SELECT 1 AS ready')
          assert.equal(result[0].ready, 1)
          return true
        }
      )
    } catch {
      const remainingMs = deadline - Date.now()
      if (remainingMs > 0) {
        await delay(Math.min(125, remainingMs))
      }
    }
  }
  throw new Error('PostgreSQL readiness timed out')
}

export async function databaseSnapshot(dataSource) {
  const [relations, columns, constraints, indexes, foreignKeys] = await Promise.all([
    dataSource.query(`
      SELECT c.relname AS name, c.relkind AS kind
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname
    `),
    dataSource.query(`
      SELECT table_name, ordinal_position, column_name, data_type, udt_name,
             is_nullable, collation_name, datetime_precision
      FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position
    `),
    dataSource.query(`
      SELECT c.relname AS table_name, con.conname AS constraint_name,
             CASE con.contype
               WHEN 'p' THEN 'PRIMARY KEY'
               WHEN 'u' THEN 'UNIQUE'
               WHEN 'f' THEN 'FOREIGN KEY'
               WHEN 'c' THEN 'CHECK'
             END AS constraint_type
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'f', 'c')
      ORDER BY c.relname, con.conname
    `),
    dataSource.query(`
      SELECT table_class.relname AS table_name, index_class.relname AS index_name,
             (
               SELECT json_agg(attribute.attname ORDER BY key.ordinality)
               FROM unnest(index_info.indkey) WITH ORDINALITY AS key(attnum, ordinality)
               JOIN pg_catalog.pg_attribute attribute
                 ON attribute.attrelid = table_class.oid AND attribute.attnum = key.attnum
             ) AS columns,
             index_info.indisunique AS is_unique,
             pg_catalog.pg_get_expr(index_info.indpred, index_info.indrelid) AS predicate
      FROM pg_catalog.pg_index index_info
      JOIN pg_catalog.pg_class table_class ON table_class.oid = index_info.indrelid
      JOIN pg_catalog.pg_class index_class ON index_class.oid = index_info.indexrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = 'public'
      ORDER BY table_class.relname, index_class.relname
    `),
    dataSource.query(`
      SELECT source.relname AS source_table, constraint_info.conname AS constraint_name,
             (
               SELECT json_agg(attribute.attname ORDER BY key.ordinality)
               FROM unnest(constraint_info.conkey) WITH ORDINALITY AS key(attnum, ordinality)
               JOIN pg_catalog.pg_attribute attribute
                 ON attribute.attrelid = source.oid AND attribute.attnum = key.attnum
             ) AS source_columns,
             target.relname AS target_table,
             (
               SELECT json_agg(attribute.attname ORDER BY key.ordinality)
               FROM unnest(constraint_info.confkey) WITH ORDINALITY AS key(attnum, ordinality)
               JOIN pg_catalog.pg_attribute attribute
                 ON attribute.attrelid = target.oid AND attribute.attnum = key.attnum
             ) AS target_columns,
             constraint_info.confdeltype AS delete_action
      FROM pg_catalog.pg_constraint constraint_info
      JOIN pg_catalog.pg_class source ON source.oid = constraint_info.conrelid
      JOIN pg_catalog.pg_class target ON target.oid = constraint_info.confrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = source.relnamespace
      WHERE namespace.nspname = 'public' AND constraint_info.contype = 'f'
      ORDER BY source.relname, constraint_info.conname
    `)
  ])
  return { relations, columns, constraints, indexes, foreignKeys }
}

const expectedColumns = Object.freeze({
  users: [
    ['id', 'uuid', 'uuid', 'NO', null, null],
    ['provider', 'text', 'text', 'NO', null, null],
    ['provider_subject', 'text', 'text', 'NO', 'C', null],
    ['nickname', 'text', 'text', 'NO', null, null],
    ['created_at', 'timestamp with time zone', 'timestamptz', 'NO', null, 0]
  ],
  auth_sessions: [
    ['id', 'uuid', 'uuid', 'NO', null, null],
    ['user_id', 'uuid', 'uuid', 'NO', null, null],
    ['created_at', 'timestamp with time zone', 'timestamptz', 'NO', null, 0],
    ['last_active_at', 'timestamp with time zone', 'timestamptz', 'NO', null, 0],
    ['revoked_at', 'timestamp with time zone', 'timestamptz', 'YES', null, 0],
    ['revoked_reason', 'text', 'text', 'YES', null, null]
  ],
  auth_refresh_tokens: [
    ['token_hash', 'bytea', 'bytea', 'NO', null, null],
    ['session_id', 'uuid', 'uuid', 'NO', null, null],
    ['issued_at', 'timestamp with time zone', 'timestamptz', 'NO', null, 0],
    ['consumed_at', 'timestamp with time zone', 'timestamptz', 'YES', null, 0]
  ],
  auth_login_requests: [
    ['id', 'uuid', 'uuid', 'NO', null, null],
    ['purpose', 'text', 'text', 'NO', null, null],
    ['provider', 'text', 'text', 'NO', null, null],
    ['client_id', 'text', 'text', 'NO', null, null],
    ['provider_config_version', 'text', 'text', 'NO', null, null],
    ['return_target_id', 'text', 'text', 'NO', null, null],
    ['created_at', 'timestamp with time zone', 'timestamptz', 'NO', null, 0],
    ['expires_at', 'timestamp with time zone', 'timestamptz', 'NO', null, 0],
    ['status', 'text', 'text', 'NO', null, null],
    ['code_challenge', 'text', 'text', 'YES', null, null],
    ['method', 'text', 'text', 'YES', null, null],
    ['launch_ticket_hash', 'bytea', 'bytea', 'YES', null, null],
    ['state_hash', 'bytea', 'bytea', 'YES', null, null],
    ['browser_binding_hash', 'bytea', 'bytea', 'YES', null, null],
    ['oidc_nonce_hash', 'bytea', 'bytea', 'YES', null, null],
    ['provider_pkce_ciphertext', 'bytea', 'bytea', 'YES', null, null],
    ['provider_pkce_iv', 'bytea', 'bytea', 'YES', null, null],
    ['provider_pkce_tag', 'bytea', 'bytea', 'YES', null, null],
    ['provider_pkce_key_id', 'text', 'text', 'YES', null, null],
    ['verified_subject', 'text', 'text', 'YES', null, null],
    ['exchange_code_hash', 'bytea', 'bytea', 'YES', null, null],
    ['code_expires_at', 'timestamp with time zone', 'timestamptz', 'YES', null, 0],
    ['consumed_at', 'timestamp with time zone', 'timestamptz', 'YES', null, 0]
  ]
})

const expectedConstraints = [
  'auth_login_requests:ck_auth_login_requests_browser_hash_length:CHECK',
  'auth_login_requests:ck_auth_login_requests_browser_started_fields:CHECK',
  'auth_login_requests:ck_auth_login_requests_client:CHECK',
  'auth_login_requests:ck_auth_login_requests_code_challenge_nonempty:CHECK',
  'auth_login_requests:ck_auth_login_requests_code_deadline:CHECK',
  'auth_login_requests:ck_auth_login_requests_config_nonempty:CHECK',
  'auth_login_requests:ck_auth_login_requests_consumed_fields:CHECK',
  'auth_login_requests:ck_auth_login_requests_created_fields:CHECK',
  'auth_login_requests:ck_auth_login_requests_exchange_hash_length:CHECK',
  'auth_login_requests:ck_auth_login_requests_exchange_ready_fields:CHECK',
  'auth_login_requests:ck_auth_login_requests_expiry:CHECK',
  'auth_login_requests:ck_auth_login_requests_failed_fields:CHECK',
  'auth_login_requests:ck_auth_login_requests_launch_hash_length:CHECK',
  'auth_login_requests:ck_auth_login_requests_method:CHECK',
  'auth_login_requests:ck_auth_login_requests_nonce_hash_length:CHECK',
  'auth_login_requests:ck_auth_login_requests_pkce_fields:CHECK',
  'auth_login_requests:ck_auth_login_requests_processing_fields:CHECK',
  'auth_login_requests:ck_auth_login_requests_provider:CHECK',
  'auth_login_requests:ck_auth_login_requests_purpose:CHECK',
  'auth_login_requests:ck_auth_login_requests_return_target_nonempty:CHECK',
  'auth_login_requests:ck_auth_login_requests_state_hash_length:CHECK',
  'auth_login_requests:ck_auth_login_requests_status:CHECK',
  'auth_login_requests:ck_auth_login_requests_subject_nonempty:CHECK',
  'auth_login_requests:pk_auth_login_requests:PRIMARY KEY',
  'auth_login_requests:uq_auth_login_requests_exchange_code_hash:UNIQUE',
  'auth_login_requests:uq_auth_login_requests_launch_ticket_hash:UNIQUE',
  'auth_login_requests:uq_auth_login_requests_state_hash:UNIQUE',
  'auth_refresh_tokens:ck_auth_refresh_tokens_consumed_time:CHECK',
  'auth_refresh_tokens:ck_auth_refresh_tokens_hash_length:CHECK',
  'auth_refresh_tokens:fk_auth_refresh_tokens_session:FOREIGN KEY',
  'auth_refresh_tokens:pk_auth_refresh_tokens:PRIMARY KEY',
  'auth_sessions:ck_auth_sessions_last_active:CHECK',
  'auth_sessions:ck_auth_sessions_revoked_pair:CHECK',
  'auth_sessions:ck_auth_sessions_revoked_reason:CHECK',
  'auth_sessions:ck_auth_sessions_revoked_time:CHECK',
  'auth_sessions:fk_auth_sessions_user:FOREIGN KEY',
  'auth_sessions:pk_auth_sessions:PRIMARY KEY',
  'users:ck_users_nickname_nonempty:CHECK',
  'users:ck_users_provider:CHECK',
  'users:ck_users_provider_subject_nonempty:CHECK',
  'users:pk_users:PRIMARY KEY',
  'users:uq_users_provider_subject:UNIQUE'
]

const expectedIndexes = [
  ['auth_login_requests', 'idx_auth_login_requests_expires_at', ['expires_at'], false, null],
  ['auth_login_requests', 'pk_auth_login_requests', ['id'], true, null],
  [
    'auth_login_requests',
    'uq_auth_login_requests_exchange_code_hash',
    ['exchange_code_hash'],
    true,
    null
  ],
  [
    'auth_login_requests',
    'uq_auth_login_requests_launch_ticket_hash',
    ['launch_ticket_hash'],
    true,
    null
  ],
  ['auth_login_requests', 'uq_auth_login_requests_state_hash', ['state_hash'], true, null],
  ['auth_refresh_tokens', 'idx_auth_refresh_tokens_session_id', ['session_id'], false, null],
  ['auth_refresh_tokens', 'pk_auth_refresh_tokens', ['token_hash'], true, null],
  [
    'auth_refresh_tokens',
    'uq_auth_refresh_tokens_unconsumed_session',
    ['session_id'],
    true,
    '(consumed_at IS NULL)'
  ],
  ['auth_sessions', 'idx_auth_sessions_last_active_at', ['last_active_at'], false, null],
  ['auth_sessions', 'idx_auth_sessions_user_id', ['user_id'], false, null],
  ['auth_sessions', 'pk_auth_sessions', ['id'], true, null],
  ['users', 'pk_users', ['id'], true, null],
  ['users', 'uq_users_provider_subject', ['provider', 'provider_subject'], true, null]
]

const expectedForeignKeys = [
  [
    'auth_refresh_tokens',
    'fk_auth_refresh_tokens_session',
    ['session_id'],
    'auth_sessions',
    ['id'],
    'c'
  ],
  ['auth_sessions', 'fk_auth_sessions_user', ['user_id'], 'users', ['id'], 'c']
]

export async function assertSchema(
  dataSource,
  mark = () => undefined,
  migrationNames = ['InitialAuthSchema1788600000000']
) {
  const snapshot = await databaseSnapshot(dataSource)
  mark('relations')
  assert.deepEqual(
    snapshot.relations.map(({ name }) => name),
    [...DOMAIN_TABLES, MIGRATIONS_TABLE].sort()
  )

  for (const [table, columns] of Object.entries(expectedColumns)) {
    mark(`columns ${table}`)
    assert.deepEqual(
      snapshot.columns
        .filter((column) => column.table_name === table)
        .map((column) => [
          column.column_name,
          column.data_type,
          column.udt_name,
          column.is_nullable,
          column.collation_name,
          column.datetime_precision
        ]),
      columns,
      `column contract differs for ${table}`
    )
  }

  mark('constraints')
  const actualConstraints = snapshot.constraints
    .filter(({ table_name }) => DOMAIN_TABLES.includes(table_name))
    .map(
      ({ table_name, constraint_name, constraint_type }) =>
        `${table_name}:${constraint_name}:${constraint_type}`
    )
  const constraintDifference = Math.max(actualConstraints.length, expectedConstraints.length)
    ? Array.from({
        length: Math.max(actualConstraints.length, expectedConstraints.length)
      }).findIndex((_, index) => actualConstraints[index] !== expectedConstraints[index])
    : -1
  if (constraintDifference >= 0) {
    mark(
      `constraints ${expectedConstraints[constraintDifference] ?? 'end'} ${actualConstraints[constraintDifference] ?? 'end'}`
    )
  }
  assert.deepEqual(actualConstraints, expectedConstraints)
  mark('indexes')
  assert.deepEqual(
    snapshot.indexes
      .filter(({ table_name }) => DOMAIN_TABLES.includes(table_name))
      .map(({ table_name, index_name, columns, is_unique, predicate }) => [
        table_name,
        index_name,
        columns,
        is_unique,
        predicate
      ]),
    expectedIndexes
  )
  mark('foreign keys')
  assert.deepEqual(
    snapshot.foreignKeys.map(
      ({
        source_table,
        constraint_name,
        source_columns,
        target_table,
        target_columns,
        delete_action
      }) => [
        source_table,
        constraint_name,
        source_columns,
        target_table,
        target_columns,
        delete_action
      ]
    ),
    expectedForeignKeys
  )

  mark('primary keys')
  const primaryKeys = await dataSource.query(
    `
    SELECT tc.table_name, json_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema AND kcu.constraint_name = tc.constraint_name
    WHERE tc.constraint_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_name = ANY($1)
    GROUP BY tc.table_name
    ORDER BY tc.table_name
  `,
    [DOMAIN_TABLES]
  )
  assert.deepEqual(primaryKeys, [
    { table_name: 'auth_login_requests', columns: ['id'] },
    { table_name: 'auth_refresh_tokens', columns: ['token_hash'] },
    { table_name: 'auth_sessions', columns: ['id'] },
    { table_name: 'users', columns: ['id'] }
  ])

  mark('migration history')
  const history = await dataSource.query(`SELECT name FROM "${MIGRATIONS_TABLE}" ORDER BY id`)
  assert.deepEqual(
    history,
    migrationNames.map((name) => ({ name }))
  )
  return snapshot
}

export async function rejectConstraint(dataSource, expectedConstraint, operation) {
  const queryRunner = dataSource.createQueryRunner()
  await queryRunner.connect()
  await queryRunner.startTransaction()
  try {
    await operation(queryRunner)
    assert.fail(`constraint ${expectedConstraint} accepted invalid data`)
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION') {
      throw error
    }
    assert.equal(error?.constraint, expectedConstraint)
  } finally {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction()
    }
    await queryRunner.release()
  }
}

const userId = '10000000-0000-4000-8000-000000000001'
const sessionId = '20000000-0000-4000-8000-000000000001'
const createdAt = new Date('2026-09-05T00:00:00Z')
const later = new Date('2026-09-05T00:01:00Z')
const expiresAt = new Date('2026-09-05T00:10:00Z')
const hash = (fill) => Buffer.alloc(32, fill)

const loginColumns = [
  'id',
  'purpose',
  'provider',
  'client_id',
  'provider_config_version',
  'return_target_id',
  'created_at',
  'expires_at',
  'status',
  'code_challenge',
  'method',
  'launch_ticket_hash',
  'state_hash',
  'browser_binding_hash',
  'oidc_nonce_hash',
  'provider_pkce_ciphertext',
  'provider_pkce_iv',
  'provider_pkce_tag',
  'provider_pkce_key_id',
  'verified_subject',
  'exchange_code_hash',
  'code_expires_at',
  'consumed_at'
]

export function loginRequest(status, id, overrides = {}) {
  const common = {
    id,
    purpose: 'login',
    provider: 'google',
    client_id: 'desktop',
    provider_config_version: 'v1',
    return_target_id: 'desktop-v1',
    created_at: createdAt,
    expires_at: expiresAt,
    status,
    code_challenge: null,
    method: null,
    launch_ticket_hash: null,
    state_hash: null,
    browser_binding_hash: null,
    oidc_nonce_hash: null,
    provider_pkce_ciphertext: null,
    provider_pkce_iv: null,
    provider_pkce_tag: null,
    provider_pkce_key_id: null,
    verified_subject: null,
    exchange_code_hash: null,
    code_expires_at: null,
    consumed_at: null
  }
  const stateFields = {
    created: { code_challenge: 'challenge', method: 'S256', launch_ticket_hash: hash(11) },
    browser_started: {
      code_challenge: 'challenge',
      method: 'S256',
      state_hash: hash(12),
      browser_binding_hash: hash(13),
      oidc_nonce_hash: hash(14),
      provider_pkce_ciphertext: hash(15),
      provider_pkce_iv: Buffer.alloc(12, 16),
      provider_pkce_tag: Buffer.alloc(16, 17),
      provider_pkce_key_id: 'key-v1'
    },
    processing: {
      code_challenge: 'challenge',
      method: 'S256',
      state_hash: hash(18),
      browser_binding_hash: hash(19),
      oidc_nonce_hash: hash(20),
      provider_pkce_ciphertext: hash(21),
      provider_pkce_iv: Buffer.alloc(12, 22),
      provider_pkce_tag: Buffer.alloc(16, 23),
      provider_pkce_key_id: 'key-v1'
    },
    exchange_ready: {
      code_challenge: 'challenge',
      method: 'S256',
      verified_subject: 'subject',
      exchange_code_hash: hash(24),
      code_expires_at: later
    },
    consumed: { consumed_at: later },
    failed: {}
  }
  return { ...common, ...stateFields[status], ...overrides }
}

export async function insertLogin(dataSource, request) {
  const values = loginColumns.map((column) => request[column])
  const identifiers = loginColumns.map((column) => `"${column}"`).join(', ')
  const parameters = values.map((_, index) => `$${index + 1}`).join(', ')
  await dataSource.query(
    `INSERT INTO "auth_login_requests" (${identifiers}) VALUES (${parameters})`,
    values
  )
}

export async function assertConstraintBehavior(dataSource) {
  await dataSource.query(
    'INSERT INTO "users" (id, provider, provider_subject, nickname, created_at) VALUES ($1, $2, $3, $4, $5)',
    [userId, 'google', 'subject-1', 'nickname', createdAt]
  )
  await dataSource.query(
    'INSERT INTO "auth_sessions" (id, user_id, created_at, last_active_at) VALUES ($1, $2, $3, $4)',
    [sessionId, userId, createdAt, later]
  )
  await dataSource.query(
    'INSERT INTO "auth_refresh_tokens" (token_hash, session_id, issued_at) VALUES ($1, $2, $3)',
    [hash(1), sessionId, createdAt]
  )

  await rejectConstraint(dataSource, 'uq_users_provider_subject', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "users" (id, provider, provider_subject, nickname, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['10000000-0000-4000-8000-000000000002', 'google', 'subject-1', 'other', createdAt]
    )
  )
  await rejectConstraint(dataSource, 'ck_users_provider_subject_nonempty', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "users" (id, provider, provider_subject, nickname, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['10000000-0000-4000-8000-000000000003', 'discord', '', 'other', createdAt]
    )
  )
  await rejectConstraint(dataSource, 'ck_users_nickname_nonempty', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "users" (id, provider, provider_subject, nickname, created_at) VALUES ($1, $2, $3, $4, $5)',
      ['10000000-0000-4000-8000-000000000004', 'discord', 'subject-4', '', createdAt]
    )
  )
  await rejectConstraint(dataSource, 'fk_auth_sessions_user', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "auth_sessions" (id, user_id, created_at, last_active_at) VALUES ($1, $2, $3, $4)',
      [
        '20000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000009999',
        createdAt,
        later
      ]
    )
  )
  await rejectConstraint(dataSource, 'ck_auth_sessions_last_active', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "auth_sessions" (id, user_id, created_at, last_active_at) VALUES ($1, $2, $3, $4)',
      ['20000000-0000-4000-8000-000000000003', userId, later, createdAt]
    )
  )
  await rejectConstraint(dataSource, 'ck_auth_sessions_revoked_pair', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "auth_sessions" (id, user_id, created_at, last_active_at, revoked_at) VALUES ($1, $2, $3, $4, $5)',
      ['20000000-0000-4000-8000-000000000004', userId, createdAt, later, later]
    )
  )
  await rejectConstraint(dataSource, 'ck_auth_sessions_revoked_reason', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "auth_sessions" (id, user_id, created_at, last_active_at, revoked_at, revoked_reason) VALUES ($1, $2, $3, $4, $5, $6)',
      ['20000000-0000-4000-8000-000000000005', userId, createdAt, later, later, 'other']
    )
  )
  await rejectConstraint(dataSource, 'ck_auth_sessions_revoked_time', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "auth_sessions" (id, user_id, created_at, last_active_at, revoked_at, revoked_reason) VALUES ($1, $2, $3, $4, $5, $6)',
      ['20000000-0000-4000-8000-000000000006', userId, later, later, createdAt, 'logout']
    )
  )
  await rejectConstraint(dataSource, 'pk_auth_refresh_tokens', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "auth_refresh_tokens" (token_hash, session_id, issued_at, consumed_at) VALUES ($1, $2, $3, $4)',
      [hash(1), sessionId, createdAt, later]
    )
  )
  await rejectConstraint(dataSource, 'uq_auth_refresh_tokens_unconsumed_session', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "auth_refresh_tokens" (token_hash, session_id, issued_at) VALUES ($1, $2, $3)',
      [hash(2), sessionId, createdAt]
    )
  )
  await rejectConstraint(dataSource, 'fk_auth_refresh_tokens_session', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "auth_refresh_tokens" (token_hash, session_id, issued_at) VALUES ($1, $2, $3)',
      [hash(3), '20000000-0000-4000-8000-000000009999', createdAt]
    )
  )
  await rejectConstraint(dataSource, 'ck_auth_refresh_tokens_hash_length', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "auth_refresh_tokens" (token_hash, session_id, issued_at, consumed_at) VALUES ($1, $2, $3, $4)',
      [Buffer.alloc(31), sessionId, createdAt, later]
    )
  )
  await rejectConstraint(dataSource, 'ck_auth_refresh_tokens_consumed_time', (queryRunner) =>
    queryRunner.query(
      'INSERT INTO "auth_refresh_tokens" (token_hash, session_id, issued_at, consumed_at) VALUES ($1, $2, $3, $4)',
      [hash(4), sessionId, later, createdAt]
    )
  )

  const validRequests = [
    loginRequest('created', '30000000-0000-4000-8000-000000000001'),
    loginRequest('browser_started', '30000000-0000-4000-8000-000000000002'),
    loginRequest('processing', '30000000-0000-4000-8000-000000000003'),
    loginRequest('exchange_ready', '30000000-0000-4000-8000-000000000004', {
      state_hash: hash(30),
      browser_binding_hash: hash(31),
      oidc_nonce_hash: hash(32),
      provider_pkce_ciphertext: hash(33),
      provider_pkce_iv: Buffer.alloc(12, 34),
      provider_pkce_tag: Buffer.alloc(16, 35),
      provider_pkce_key_id: 'retained-key'
    }),
    loginRequest('consumed', '30000000-0000-4000-8000-000000000005'),
    loginRequest('failed', '30000000-0000-4000-8000-000000000006')
  ]
  for (const request of validRequests) {
    await insertLogin(dataSource, request)
  }

  const invalidRequests = [
    [
      'ck_auth_login_requests_status',
      loginRequest('created', '30000000-0000-4000-8000-000000000010', { status: 'unknown' })
    ],
    [
      'ck_auth_login_requests_created_fields',
      loginRequest('created', '30000000-0000-4000-8000-000000000011', { method: null })
    ],
    [
      'ck_auth_login_requests_browser_started_fields',
      loginRequest('browser_started', '30000000-0000-4000-8000-000000000012', {
        launch_ticket_hash: hash(40)
      })
    ],
    [
      'ck_auth_login_requests_processing_fields',
      loginRequest('processing', '30000000-0000-4000-8000-000000000013', {
        verified_subject: 'too-early'
      })
    ],
    [
      'ck_auth_login_requests_exchange_ready_fields',
      loginRequest('exchange_ready', '30000000-0000-4000-8000-000000000014', { method: null })
    ],
    [
      'ck_auth_login_requests_consumed_fields',
      loginRequest('consumed', '30000000-0000-4000-8000-000000000015', {
        code_challenge: 'retained'
      })
    ],
    [
      'ck_auth_login_requests_failed_fields',
      loginRequest('failed', '30000000-0000-4000-8000-000000000016', {
        verified_subject: 'retained'
      })
    ],
    [
      'ck_auth_login_requests_pkce_fields',
      loginRequest('exchange_ready', '30000000-0000-4000-8000-000000000017', {
        provider_pkce_ciphertext: hash(41)
      })
    ],
    [
      'ck_auth_login_requests_expiry',
      loginRequest('created', '30000000-0000-4000-8000-000000000018', { expires_at: createdAt })
    ],
    [
      'ck_auth_login_requests_code_deadline',
      loginRequest('exchange_ready', '30000000-0000-4000-8000-000000000019', {
        code_expires_at: new Date('2026-09-05T00:11:00Z')
      })
    ],
    [
      'ck_auth_login_requests_launch_hash_length',
      loginRequest('created', '30000000-0000-4000-8000-000000000020', {
        launch_ticket_hash: Buffer.alloc(31)
      })
    ],
    [
      'ck_auth_login_requests_state_hash_length',
      loginRequest('exchange_ready', '30000000-0000-4000-8000-000000000021', {
        state_hash: Buffer.alloc(31)
      })
    ],
    [
      'ck_auth_login_requests_browser_hash_length',
      loginRequest('exchange_ready', '30000000-0000-4000-8000-000000000022', {
        browser_binding_hash: Buffer.alloc(31)
      })
    ],
    [
      'ck_auth_login_requests_nonce_hash_length',
      loginRequest('exchange_ready', '30000000-0000-4000-8000-000000000023', {
        oidc_nonce_hash: Buffer.alloc(31)
      })
    ],
    [
      'ck_auth_login_requests_exchange_hash_length',
      loginRequest('exchange_ready', '30000000-0000-4000-8000-000000000024', {
        exchange_code_hash: Buffer.alloc(31)
      })
    ],
    [
      'ck_auth_login_requests_config_nonempty',
      loginRequest('created', '30000000-0000-4000-8000-000000000025', {
        provider_config_version: ''
      })
    ],
    [
      'ck_auth_login_requests_return_target_nonempty',
      loginRequest('created', '30000000-0000-4000-8000-000000000026', { return_target_id: '' })
    ],
    [
      'ck_auth_login_requests_browser_started_fields',
      loginRequest('browser_started', '30000000-0000-4000-8000-000000000030', { method: null })
    ],
    [
      'ck_auth_login_requests_processing_fields',
      loginRequest('processing', '30000000-0000-4000-8000-000000000031', { method: null })
    ],
    [
      'ck_auth_login_requests_exchange_ready_fields',
      loginRequest('exchange_ready', '30000000-0000-4000-8000-000000000032', {
        verified_subject: null
      })
    ],
    [
      'ck_auth_login_requests_consumed_fields',
      loginRequest('consumed', '30000000-0000-4000-8000-000000000033', { consumed_at: null })
    ]
  ]
  for (const [constraint, request] of invalidRequests) {
    await rejectConstraint(dataSource, constraint, (queryRunner) =>
      insertLogin(queryRunner, request)
    )
  }

  await rejectConstraint(dataSource, 'uq_auth_login_requests_launch_ticket_hash', (queryRunner) =>
    insertLogin(queryRunner, loginRequest('created', '30000000-0000-4000-8000-000000000027'))
  )
  await rejectConstraint(dataSource, 'uq_auth_login_requests_state_hash', (queryRunner) =>
    insertLogin(
      queryRunner,
      loginRequest('exchange_ready', '30000000-0000-4000-8000-000000000028', {
        state_hash: hash(12)
      })
    )
  )
  await rejectConstraint(dataSource, 'uq_auth_login_requests_exchange_code_hash', (queryRunner) =>
    insertLogin(queryRunner, loginRequest('exchange_ready', '30000000-0000-4000-8000-000000000029'))
  )

  await dataSource.query('DELETE FROM "users" WHERE id = $1', [userId])
  const cascadeCounts = await dataSource.query(
    `
    SELECT
      (SELECT count(*)::int FROM "auth_sessions" WHERE user_id = $1) AS sessions,
      (SELECT count(*)::int FROM "auth_refresh_tokens" WHERE session_id = $2) AS refresh_tokens
  `,
    [userId, sessionId]
  )
  assert.deepEqual(cascadeCounts, [{ sessions: 0, refresh_tokens: 0 }])
}
