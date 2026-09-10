/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Native Node ESM cannot use TypeScript return annotations. */
import '../../../api/node_modules/reflect-metadata/Reflect.js'
import assert from 'node:assert/strict'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createDatabaseDataSource } from '../../../api/dist/database/index.js'
import {
  assertResourcesAbsent,
  createPostgres,
  newRunId,
  teardownPostgres,
  verifyApprovedImage
} from '../../../api/test-support/docker-postgres.mjs'
import { waitForAuthenticatedReadiness } from '../../../api/test-support/database-contract.mjs'
import {
  isolatedGoogle,
  prepare,
  completion
} from '../../../api/test-support/google-http-integration.mjs'
import { isolatedNeople } from '../../../api/test-support/character-search-fixtures.mjs'
import {
  collectRuntimeExit,
  runtimeEnvironment,
  startRuntime,
  stopRuntime,
  unusedRuntimePort,
  waitForRuntime,
  withRuntimeConfiguration
} from '../../../api/test-support/runtime-fixtures.mjs'

const apiDirectory = fileURLToPath(new URL('../../../api/', import.meta.url))

function startApi(environment, upstreams) {
  const originalDirectory = process.cwd()
  try {
    // 기존 helper의 상대 entry만 API checkout에서 resolve한다. 전용 forks process에서 동기 복원한다.
    process.chdir(apiDirectory)
    return startRuntime(environment, { realDatabase: true, upstreams })
  } finally {
    process.chdir(originalDirectory)
  }
}

async function withApi({ source, database, google, neople }, operation) {
  return withRuntimeConfiguration(async ({ path }) => {
    const port = await unusedRuntimePort()
    const runtime = startApi(runtimeEnvironment(path, port, database), {
      google: google.origin,
      neople: neople.origin
    })
    try {
      await waitForRuntime(port, runtime)
      const base = `http://127.0.0.1:${port}`
      const post = (route, body) =>
        fetch(`${base}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
      const flow = await prepare({ base, post }, google)
      const exchange = await completion(flow, await flow.callback(), google.canaries)
      const response = await post('/auth/exchange', exchange)
      assert.equal(response.status, 200)
      const tokens = await response.json()
      const hasAccessToken = typeof tokens.accessToken === 'string'
      assert(hasAccessToken, 'server exchange must issue access')
      const [{ count }] = await source.query('SELECT count(*)::int AS count FROM auth_sessions')
      assert.equal(count, 1, 'server exchange must persist a session')

      await operation({ base, accessToken: tokens.accessToken, source, neople })
    } finally {
      try {
        runtime.child.kill('SIGTERM')
        const result = await collectRuntimeExit(runtime)
        assert.equal(result.code, 0, 'API must exit cleanly')
        assert.equal(result.signal, null)
        const hasNoStdout = result.stdout.length === 0
        const hasNoStderr = result.stderr.length === 0
        const hasNoRuntimeOutput = hasNoStdout && hasNoStderr
        assert(hasNoRuntimeOutput, 'API must not log raw fixture data')
        const events = runtime.events.map(({ event }) => event)
        const hasDisconnectedDatabase = events.includes('db.disconnected')
        assert(hasDisconnectedDatabase, 'API must disconnect its real database')
        const hasClosedApplication = events.includes('app.closed')
        assert(hasClosedApplication, 'API must close its HTTP application')
      } finally {
        await stopRuntime(runtime)
      }
    }
  })
}

/**
 * @param {(context: {
 *   base: string,
 *   accessToken: string,
 *   source: ReturnType<typeof createDatabaseDataSource>,
 *   neople: Omit<Awaited<ReturnType<typeof isolatedNeople>>, 'upstream'> & { upstream: { body: unknown } }
 * }) => Promise<void>} operation
 */
export async function withSearchServer(operation) {
  const runId = newRunId('desktopsearch')
  const image = await verifyApprovedImage()
  const resources = await createPostgres(runId, image)
  let source
  let google
  let neople
  try {
    source = createDatabaseDataSource(resources.configuration)
    await waitForAuthenticatedReadiness(createDatabaseDataSource, resources.configuration)
    await source.initialize()
    await source.runMigrations({ transaction: 'all' })
    google = await isolatedGoogle()
    neople = await isolatedNeople()
    await withApi({ source, database: resources.configuration, google, neople }, operation)
    assert.equal(google.failed, false)
    assert.equal(neople.upstream.failure, undefined)
  } finally {
    const cleanup = [
      async () => {
        const hasNeople = neople != null
        if (hasNeople) {
          await neople.close()
        }
      },
      async () => {
        const hasGoogle = google != null
        if (hasGoogle) {
          await google.close()
        }
      },
      async () => {
        const hasSource = source != null
        if (hasSource) {
          const hasInitializedSource = source.isInitialized
          if (hasInitializedSource) {
            await source.destroy()
          }
        }
      },
      async () => {
        await teardownPostgres(resources)
        await assertResourcesAbsent(runId)
      }
    ]
    await closeOwnedResources(cleanup)
  }
}

async function closeOwnedResources(cleanup) {
  const errors = []
  for (const close of cleanup) {
    try {
      await close()
    } catch {
      errors.push(new Error('Owned search integration resource cleanup failed'))
    }
  }
  const hasCleanupErrors = errors.length > 0
  if (hasCleanupErrors) {
    throw new AggregateError(errors, 'Search integration cleanup failed')
  }
}
