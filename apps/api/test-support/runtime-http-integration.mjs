/* global fetch */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createAccessJwtVerifier } from '../dist/auth/access-jwt/index.js'
import { createDatabaseDataSource } from '../dist/database/index.js'
import { databaseSnapshot, withDataSource } from './database-contract.mjs'
import { completion, isolatedGoogle, prepare } from './google-http-integration.mjs'
import { assertBackendGone, isolatedNeople, waitFor } from './character-search-fixtures.mjs'
import {
  assertStartupFailure,
  collectRuntimeExit,
  runtimeEnvironment,
  startRuntime,
  stopRuntime,
  unusedRuntimePort,
  waitForRuntime,
  withRuntimeConfiguration
} from './runtime-fixtures.mjs'

function backendPids(runtime) {
  return runtime.events.filter(({ event }) => event === 'db.backend').map(({ detail }) => detail)
}

async function assertDisconnected(source, runtime) {
  const pids = backendPids(runtime)
  assert(pids.length > 0, 'default entry must acquire an observable database connection')
  for (const pid of pids) {
    await assertBackendGone(source, pid)
  }
  const disconnected = runtime.events.some(({ event }) => event === 'db.disconnected')
  assert(disconnected, 'runtime must explicitly finish database cleanup')
}

async function terminateRuntime(source, runtime, signal = 'SIGTERM') {
  runtime.child.kill(signal)
  const result = await collectRuntimeExit(runtime)
  assert.deepEqual(result, { code: 0, signal: null, stdout: '', stderr: '' })
  await assertDisconnected(source, runtime)
}

export async function assertRuntimeFreshStart(configuration, mark = () => {}) {
  await withDataSource(createDatabaseDataSource, configuration, async (source) => {
    const before = await databaseSnapshot(source)
    assert.deepEqual(before.relations, [])
    await withRuntimeConfiguration(async ({ path }) => {
      const port = await unusedRuntimePort()
      const runtime = startRuntime(runtimeEnvironment(path, port, configuration), {
        realDatabase: true
      })
      try {
        await waitForRuntime(port, runtime)
        mark('fresh database: GET /me without a token returns 401 and startup leaves schema empty')
        const response = await fetch(`http://127.0.0.1:${port}/me`)
        assert.equal(response.status, 401)
        assert.deepEqual(await databaseSnapshot(source), before)
        await terminateRuntime(source, runtime, 'SIGINT')
        assert.deepEqual(await databaseSnapshot(source), before)
      } finally {
        await stopRuntime(runtime)
      }
    })
  })
}

export async function assertRuntimeDatabaseFailures(configuration, mark = () => {}) {
  await withDataSource(createDatabaseDataSource, configuration, async (source) => {
    const before = await databaseSnapshot(source)
    for (const fault of [
      'partial-connect',
      'app-create',
      'nest-provider',
      'app-configure',
      'listen'
    ]) {
      mark(`${fault}: startup fails safely and its PostgreSQL backend disappears`)
      const server = createServer()
      const hasOccupiedPort = fault === 'listen'
      if (hasOccupiedPort) {
        await new Promise((resolve) => server.listen(0, resolve))
      }
      try {
        await withRuntimeConfiguration(async ({ path }) => {
          const port = hasOccupiedPort ? server.address().port : await unusedRuntimePort()
          const runtime = startRuntime(runtimeEnvironment(path, port, configuration), {
            realDatabase: true,
            fault
          })
          try {
            assertStartupFailure(await collectRuntimeExit(runtime))
            await assertDisconnected(source, runtime)
            assert.deepEqual(await databaseSnapshot(source), before)
          } finally {
            await stopRuntime(runtime)
          }
        })
      } finally {
        if (hasOccupiedPort) {
          await new Promise((resolve) => server.close(resolve))
        }
      }
    }
  })
}

function httpClient(port) {
  const base = `http://127.0.0.1:${port}`
  return {
    base,
    post: (path, body) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
  }
}

async function accountRequest(client, accessToken, nickname) {
  const isMutation = nickname !== undefined
  return fetch(`${client.base}${isMutation ? '/me/nickname' : '/me'}`, {
    method: isMutation ? 'PATCH' : 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(isMutation ? { 'content-type': 'application/json' } : {})
    },
    ...(isMutation ? { body: JSON.stringify({ nickname }) } : {})
  })
}

async function search(client, accessToken) {
  return fetch(`${client.base}/characters?characterName=ab`, {
    headers: { authorization: `Bearer ${accessToken}` }
  })
}

async function assertSearchShutdown(source, runtime, client, tokens, principal, neople) {
  const lock = source.createQueryRunner()
  let pending
  try {
    await lock.startTransaction()
    await lock.query('SELECT id FROM auth_sessions WHERE id=$1 FOR UPDATE', [principal.sessionId])
    const beforeCalls = neople.calls.length
    pending = search(client, tokens.accessToken).then(
      (response) => ({ response }),
      () => ({ disconnected: true })
    )
    let blockedPid
    await waitFor(async () => {
      const blocked = await source.query(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%auth_sessions%'`)
      blockedPid = blocked[0]?.pid
      return blockedPid !== undefined
    }, 'default entry search did not reach a real database lock wait')
    // 부모의 lock을 유지한 채 종료해 DB 연결 취소가 실제로 완료되는지 확인한다.
    await terminateRuntime(source, runtime)
    await assertBackendGone(source, blockedPid)
    const result = await pending
    const hasResponse = result.response !== undefined
    if (hasResponse) {
      assert.equal(result.response.status, 500)
    }
    assert.equal(neople.calls.length, beforeCalls)
    const events = runtime.events.map(({ event }) => event)
    assert(events.indexOf('app.closed') < events.indexOf('db.destroy'))
  } finally {
    await stopRuntime(runtime)
    const hasPending = pending !== undefined
    if (hasPending) {
      await pending
    }
    if (lock.isTransactionActive) {
      await lock.rollbackTransaction()
    }
    await lock.release()
  }
}

export async function assertRuntimeHttpIntegration(configuration, mark = () => {}) {
  const google = await isolatedGoogle()
  const neople = await isolatedNeople()
  const runtimes = []
  try {
    await withDataSource(createDatabaseDataSource, configuration, async (source) => {
      const beforeSchema = await databaseSnapshot(source)
      await withRuntimeConfiguration(async ({ path, configuration: auth }) => {
        const port = await unusedRuntimePort()
        const client = httpClient(port)
        const options = {
          realDatabase: true,
          upstreams: { google: google.origin, neople: neople.origin }
        }
        const first = startRuntime(runtimeEnvironment(path, port, configuration), options)
        runtimes.push(first)
        await waitForRuntime(port, first)
        mark('default entry POST /auth/login-requests returns 201 and browser start returns 303')
        const flow = await prepare(client, google)
        mark('restart preserves the pending request and the deployment PKCE key')
        await terminateRuntime(source, first)

        const previous = auth.registry.registrations[0]
        const next = {
          ...previous,
          version: 'test-v2',
          returnTarget: { ...previous.returnTarget, id: 'test-return-v2' }
        }
        auth.registry.activeVersions.google = next.version
        auth.registry.registrations.push(next)
        auth.google.registrations.push({ ...auth.google.registrations[0], version: next.version })
        // 같은 reference라도 새 version의 secret으로 이전 callback을 교환하면 fixture가 거절한다.
        auth.google.secrets.push({
          version: next.version,
          reference: previous.providerSecretRef,
          value: 'fixture-different-active-secret'
        })
        await writeFile(path, JSON.stringify(auth))
        const runtime = startRuntime(runtimeEnvironment(path, port, configuration), options)
        runtimes.push(runtime)
        await waitForRuntime(port, runtime)
        await writeFile(path, '{replaced-after-start')
        mark(
          'historical callback uses exact version/secret and the process reads configuration only once'
        )
        const exchange = await completion(flow, await flow.callback(), google.canaries)
        const exchanged = await client.post('/auth/exchange', exchange)
        assert.equal(exchanged.status, 200)
        const tokens = await exchanged.json()
        const verifyJwt = await createAccessJwtVerifier(auth.accessJwt)
        const principal = await verifyJwt(tokens.accessToken, Math.floor(Date.now() / 1000))
        assert.equal(principal.userId, tokens.user.id)
        const [storedUser] = await source.query(
          'SELECT provider, provider_subject FROM users WHERE id=$1',
          [tokens.user.id]
        )
        assert.equal(storedUser.provider, 'google')
        assert.equal(storedUser.provider_subject === google.subject, true)
        assert.equal(google.calls, 1)
        assert.equal(google.failed, false)

        mark('same app reads and updates the authenticated account, then searches through Neople')
        const profile = await accountRequest(client, tokens.accessToken)
        assert.equal(profile.status, 200)
        assert.deepEqual(await profile.json(), { user: tokens.user })
        const changed = await accountRequest(client, tokens.accessToken, '기본 실행 사용자')
        assert.equal(changed.status, 200)
        assert.deepEqual(await changed.json(), {
          user: { id: tokens.user.id, nickname: '기본 실행 사용자' }
        })
        neople.upstream.body = {
          rows: [
            { characterId: 'fixture-character', characterName: 'ab', serverId: 'cain', fame: 0 }
          ]
        }
        const found = await search(client, tokens.accessToken)
        assert.equal(found.status, 200)
        assert.deepEqual(await found.json(), {
          rows: [
            {
              characterId: 'fixture-character',
              characterName: 'ab',
              serverId: 'cain',
              serverName: '카인',
              fame: 0
            }
          ]
        })
        assert.equal(neople.calls.length, 1)
        assert.equal(neople.calls[0].hasExpectedKey, true)

        mark(
          'same app refreshes and logs out, denies both account routes but permits residual JWT search'
        )
        const refreshed = await client.post('/auth/refresh', { refreshToken: tokens.refreshToken })
        assert.equal(refreshed.status, 200)
        const rotated = await refreshed.json()
        await verifyJwt(rotated.accessToken, Math.floor(Date.now() / 1000))
        assert.equal(
          (await client.post('/auth/logout', { refreshToken: rotated.refreshToken })).status,
          204
        )
        assert.equal((await accountRequest(client, rotated.accessToken)).status, 401)
        assert.equal((await accountRequest(client, rotated.accessToken, '거절될 변경')).status, 401)
        assert.equal((await search(client, rotated.accessToken)).status, 200)
        assert.equal(
          (await client.post('/auth/refresh', { refreshToken: rotated.refreshToken })).status,
          401
        )
        assert.equal(neople.calls.length, 2)
        const [session] = await source.query(
          'SELECT revoked_reason FROM auth_sessions WHERE id=$1',
          [principal.sessionId]
        )
        assert.equal(session.revoked_reason, 'logout')
        assert.deepEqual(await databaseSnapshot(source), beforeSchema)

        mark(
          'SIGTERM cancels a real locked search before app and DB shutdown; upstream is not called'
        )
        await assertSearchShutdown(source, runtime, client, rotated, principal, neople)
        assert.equal(neople.upstream.failure, undefined)
      })
    })
    return 6
  } finally {
    for (const runtime of runtimes) {
      await stopRuntime(runtime)
    }
    await google.close()
    await neople.close()
  }
}
