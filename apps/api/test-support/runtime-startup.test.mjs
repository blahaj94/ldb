/* global fetch */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
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

const eventsOf = (runtime) => runtime.events.map(({ event }) => event)

test('build entry preserves 404 for unregistered paths and existing registered route failures', async (t) => {
  await withRuntimeConfiguration(async ({ path }) => {
    const port = await unusedRuntimePort()
    const runtime = startRuntime(runtimeEnvironment(path, port))
    const canary = 'fixture-unregistered-request-secret'
    try {
      await waitForRuntime(port, runtime)
      const base = `http://127.0.0.1:${port}`
      for (const [name, method, route] of [
        ['root', 'GET', '/'],
        ['unknown path', 'GET', '/not-registered'],
        ['unknown auth path', 'GET', `/auth/not-registered?code=${canary}`],
        ['unknown account path', 'GET', `/me/not-registered?token=${canary}`],
        ['unknown search path', 'GET', `/characters/not-registered?token=${canary}`],
        ['unknown HEAD path', 'HEAD', `/not-registered?token=${canary}`]
      ]) {
        await t.test(name, async () => {
          const response = await fetch(`${base}${route}`, {
            method,
            headers: { authorization: `Bearer ${canary}`, cookie: `fixture=${canary}` }
          })
          assert.equal(response.status, 404)
          assert.equal(response.headers.get('cache-control'), 'no-store')
          const body = await response.text()
          assert.equal(
            body.includes(canary),
            false,
            '404 response must not reflect request credentials'
          )
          assert.doesNotMatch(body, /AUTH_INTERNAL_ERROR|NotFoundException|\bat .*\.js:/)
          const isHead = method === 'HEAD'
          if (isHead) {
            assert.equal(body, '')
          }
        })
      }
      for (const [name, method, route, status, code] of [
        ['account authentication', 'GET', '/me', 401, 'AUTHENTICATION_REQUIRED'],
        [
          'search authentication before query',
          'GET',
          '/characters?unknown=value',
          401,
          'AUTHENTICATION_REQUIRED'
        ],
        ['login JSON validation', 'POST', '/auth/login-requests', 400, 'INVALID_AUTH_REQUEST'],
        ['account HEAD refusal', 'HEAD', '/me', 400],
        ['authorize HEAD refusal', 'HEAD', '/auth/login/authorize', 400],
        ['callback validation', 'GET', '/auth/callback/google', 400]
      ]) {
        await t.test(name, async () => {
          const isPost = method === 'POST'
          const response = await fetch(`${base}${route}`, {
            method,
            ...(isPost ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {})
          })
          assert.equal(response.status, status)
          assert.equal(response.headers.get('cache-control'), 'no-store')
          const hasJsonCode = code !== undefined
          if (hasJsonCode) {
            assert.equal((await response.json()).error.code, code)
          }
          const isHead = method === 'HEAD'
          if (isHead) {
            assert.equal(await response.text(), '')
          }
        })
      }
      runtime.child.kill('SIGTERM')
      assert.deepEqual(await collectRuntimeExit(runtime), {
        code: 0,
        signal: null,
        stdout: '',
        stderr: ''
      })
    } finally {
      await stopRuntime(runtime)
    }
  })
})

async function rejectedBeforeInitialization(environment) {
  const runtime = startRuntime(environment, { fault: 'stop-before-listen' })
  try {
    const result = await collectRuntimeExit(runtime)
    assertStartupFailure(result)
    assert.deepEqual(
      eventsOf(runtime),
      [],
      'invalid configuration must not initialize DB, create an app or listen'
    )
  } finally {
    await stopRuntime(runtime)
  }
}

test('build entry validates required environment before acquiring resources', async (t) => {
  await withRuntimeConfiguration(async ({ path }) => {
    const port = await unusedRuntimePort()
    const valid = runtimeEnvironment(path, port)
    for (const name of Object.keys(valid)) {
      for (const value of [undefined, '']) {
        const kind = value === undefined ? 'missing' : 'empty'
        await t.test(`${name} ${kind}`, () =>
          rejectedBeforeInitialization({ ...valid, [name]: value })
        )
      }
    }
    for (const value of ['0', '65536', '1.5', '+1', '-1', ' 1', '１']) {
      await t.test(`invalid PORT ${value}`, () =>
        rejectedBeforeInitialization({ ...valid, PORT: value })
      )
    }
    for (const value of ['0', '65536', '1.5', 'port-canary']) {
      await t.test(`invalid DB_PORT ${value}`, () =>
        rejectedBeforeInitialization({ ...valid, DB_PORT: value })
      )
    }
    for (const [name, value] of [
      ['relative path', 'auth.json'],
      ['unexpanded home', '~/auth.json'],
      ['missing file', `${path}.missing`],
      ['directory', path.slice(0, path.lastIndexOf('/'))]
    ]) {
      await t.test(name, () => rejectedBeforeInitialization({ ...valid, AUTH_CONFIG_FILE: value }))
    }
  })
})

test('build entry rejects malformed authentication JSON and exact binding violations before DB', async (t) => {
  await withRuntimeConfiguration(async ({ path, configuration }) => {
    const env = runtimeEnvironment(path, await unusedRuntimePort())
    for (const text of ['{broken-json-canary', 'null', '[]', '"config-canary"']) {
      await writeFile(path, text)
      await t.test('invalid JSON document', () => rejectedBeforeInitialization(env))
    }
    const cases = [
      [
        'missing root field',
        (c) => {
          delete c.accessJwt
        }
      ],
      [
        'unknown root field',
        (c) => {
          c.testMode = true
        }
      ],
      [
        'wrong issuer type',
        (c) => {
          c.accessJwt.issuer = 12
        }
      ],
      [
        'unknown signing field',
        (c) => {
          c.accessJwt.signingKey.extra = true
        }
      ],
      [
        'missing signing PEM',
        (c) => {
          delete c.accessJwt.signingKey.privateKeyPem
        }
      ],
      [
        'unusable signing PEM',
        (c) => {
          c.accessJwt.signingKey.privateKeyPem = 'private-key-canary'
        }
      ],
      [
        'unregistered signing kid',
        (c) => {
          c.accessJwt.signingKey.kid = 'unknown-key'
        }
      ],
      [
        'duplicate verification kid',
        (c) => {
          c.accessJwt.verificationKeys.push(c.accessJwt.verificationKeys[0])
        }
      ],
      [
        'wrong verification collection',
        (c) => {
          c.accessJwt.verificationKeys = {}
        }
      ],
      [
        'wrong verification element',
        (c) => {
          c.accessJwt.verificationKeys = [null]
        }
      ],
      [
        'missing active PKCE key',
        (c) => {
          c.providerPkce.activeKeyId = 'unknown-key'
        }
      ],
      [
        'duplicate PKCE key id',
        (c) => {
          c.providerPkce.keys.push(c.providerPkce.keys[0])
        }
      ],
      [
        'padded PKCE encoding',
        (c) => {
          c.providerPkce.keys[0].key += '='
        }
      ],
      [
        'noncanonical PKCE encoding',
        (c) => {
          c.providerPkce.keys[0].key = `${'A'.repeat(42)}B`
        }
      ],
      [
        'wrong PKCE length',
        (c) => {
          c.providerPkce.keys[0].key = 'A'.repeat(42)
        }
      ],
      [
        'wrong PKCE value type',
        (c) => {
          c.providerPkce.keys[0].key = []
        }
      ],
      [
        'unknown PKCE field',
        (c) => {
          c.providerPkce.keys[0].extra = true
        }
      ],
      [
        'missing registry snapshot',
        (c) => {
          c.registry.registrations = []
        }
      ],
      [
        'unregistered active version',
        (c) => {
          c.registry.activeVersions.google = 'unknown-version'
        }
      ],
      [
        'unsupported active provider',
        (c) => {
          c.registry.activeVersions.discord = 'test-v1'
        }
      ],
      [
        'unsupported registration',
        (c) => {
          c.registry.registrations[0].provider = 'discord'
        }
      ],
      [
        'duplicate registry version',
        (c) => {
          c.registry.registrations.push(c.registry.registrations[0])
        }
      ],
      [
        'wrong audience binding',
        (c) => {
          c.registry.registrations[0].expectedAudience = 'wrong-client'
        }
      ],
      [
        'wrong callback binding',
        (c) => {
          c.registry.registrations[0].callbackUrl = 'https://other.invalid/auth/callback/google'
        }
      ],
      [
        'unknown return target field',
        (c) => {
          c.registry.registrations[0].returnTarget.extra = true
        }
      ],
      [
        'missing Google endpoint',
        (c) => {
          c.google.registrations = []
        }
      ],
      [
        'duplicate Google endpoint',
        (c) => {
          c.google.registrations.push(c.google.registrations[0])
        }
      ],
      [
        'orphan Google endpoint',
        (c) => {
          c.google.registrations[0].version = 'unknown-version'
        }
      ],
      [
        'HTTP token endpoint',
        (c) => {
          c.google.registrations[0].tokenEndpoint = 'http://not-trusted.invalid/token'
        }
      ],
      [
        'JWKS userinfo',
        (c) => {
          c.google.registrations[0].jwksUri = 'https://user:password@keys.invalid/certs'
        }
      ],
      [
        'unknown Google transport',
        (c) => {
          c.google.fetch = 'test-override'
        }
      ],
      [
        'missing secret',
        (c) => {
          c.google.secrets = []
        }
      ],
      [
        'duplicate secret tuple',
        (c) => {
          c.google.secrets.push(c.google.secrets[0])
        }
      ],
      [
        'wrong secret version',
        (c) => {
          c.google.secrets[0].version = 'unknown-version'
        }
      ],
      [
        'wrong secret reference',
        (c) => {
          c.google.secrets[0].reference = 'unknown-reference'
        }
      ],
      [
        'blank secret',
        (c) => {
          c.google.secrets[0].value = '  '
        }
      ],
      [
        'wrong secret type',
        (c) => {
          c.google.secrets[0].value = null
        }
      ],
      [
        'unknown secret field',
        (c) => {
          c.google.secrets[0].path = '/unused-secret'
        }
      ]
    ]
    for (const [name, mutate] of cases) {
      const candidate = JSON.parse(JSON.stringify(configuration))
      mutate(candidate)
      await writeFile(path, JSON.stringify(candidate))
      await t.test(name, () => rejectedBeforeInitialization(env))
    }
  })
})

test('build entry connects once and closes the app before its DB on termination', async (t) => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    await t.test(signal, () =>
      withRuntimeConfiguration(async ({ path }) => {
        const port = await unusedRuntimePort()
        const runtime = startRuntime(runtimeEnvironment(path, port))
        try {
          await waitForRuntime(port, runtime)
          runtime.child.kill(signal)
          const result = await collectRuntimeExit(runtime)
          assert.deepEqual(result, { code: 0, signal: null, stdout: '', stderr: '' })
          assert.deepEqual(eventsOf(runtime), [
            'db.initialize',
            'app.create',
            'app.listen',
            'app.close',
            'app.closed',
            'db.destroy',
            'db.disconnected'
          ])
        } finally {
          await stopRuntime(runtime)
        }
      })
    )
  }
})

test('build entry releases owned resources after partial setup and app cleanup failures', async (t) => {
  const cases = [
    ['partial-connect', ['db.initialize', 'db.disconnected']],
    ['app-create', ['db.initialize', 'app.create', 'db.destroy', 'db.disconnected']],
    ['nest-provider', ['db.initialize', 'app.create', 'db.destroy', 'db.disconnected']],
    [
      'app-configure',
      ['db.initialize', 'app.create', 'app.close', 'app.closed', 'db.destroy', 'db.disconnected']
    ],
    [
      'app-close',
      [
        'db.initialize',
        'app.create',
        'app.listen',
        'app.close',
        'app.closed',
        'db.destroy',
        'db.disconnected'
      ]
    ]
  ]
  for (const [fault, expectedEvents] of cases) {
    await t.test(fault, () =>
      withRuntimeConfiguration(async ({ path }) => {
        const port = await unusedRuntimePort()
        const runtime = startRuntime(runtimeEnvironment(path, port), { fault })
        try {
          const needsSignal = fault === 'app-close'
          if (needsSignal) {
            await waitForRuntime(port, runtime)
            runtime.child.kill('SIGTERM')
          }
          const result = await collectRuntimeExit(runtime)
          assertStartupFailure(result)
          assert.deepEqual(eventsOf(runtime), expectedEvents)
        } finally {
          await stopRuntime(runtime)
        }
      })
    )
  }
})

test('occupied port fails without exposing configuration and closes the initialized DB', async () => {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, resolve))
  try {
    await withRuntimeConfiguration(async ({ path }) => {
      const runtime = startRuntime(runtimeEnvironment(path, server.address().port))
      try {
        assertStartupFailure(await collectRuntimeExit(runtime))
        assert.deepEqual(eventsOf(runtime), [
          'db.initialize',
          'app.create',
          'app.listen',
          'app.close',
          'app.closed',
          'db.destroy',
          'db.disconnected'
        ])
      } finally {
        await stopRuntime(runtime)
      }
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('signals during initialization and pending listen cannot leave a late running app', async (t) => {
  for (const [fault, observed] of [
    ['initialize-signal', 'db.initializing'],
    ['listen-signal', 'app.listen-pending']
  ]) {
    await t.test(fault, () =>
      withRuntimeConfiguration(async ({ path }) => {
        const port = await unusedRuntimePort()
        const runtime = startRuntime(runtimeEnvironment(path, port), { fault })
        try {
          let hasReachedStage = false
          for (let attempt = 0; attempt < 200; attempt += 1) {
            hasReachedStage = eventsOf(runtime).includes(observed)
            if (hasReachedStage) {
              break
            }
            assert.equal(runtime.child.exitCode, null)
            await delay(10)
          }
          assert(hasReachedStage, 'runtime did not reach the delayed startup stage')
          runtime.child.kill('SIGTERM')
          const result = await collectRuntimeExit(runtime)
          assert.deepEqual(result, { code: 0, signal: null, stdout: '', stderr: '' })
          const events = eventsOf(runtime)
          assert.deepEqual(events.slice(-4), [
            'app.close',
            'app.closed',
            'db.destroy',
            'db.disconnected'
          ])
          const wasInitializing = fault === 'initialize-signal'
          if (wasInitializing) {
            assert.equal(events.includes('app.listen'), false)
          }
        } finally {
          await stopRuntime(runtime)
        }
      })
    )
  }
})
