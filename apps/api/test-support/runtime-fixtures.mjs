/* global fetch */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import { registration } from './login-fixtures.mjs'
import { jwksUri, tokenEndpoint } from './google-fixtures.mjs'

export function authenticationConfiguration() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const snapshot = registration()
  return {
    accessJwt: {
      issuer: 'https://issuer.test.invalid',
      audience: 'runtime-test-api',
      signingKey: {
        kid: 'runtime-test-key',
        privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
      },
      verificationKeys: [
        {
          kid: 'runtime-test-key',
          publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' })
        }
      ]
    },
    providerPkce: {
      activeKeyId: 'runtime-test-pkce',
      keys: [{ id: 'runtime-test-pkce', key: randomBytes(32).toString('base64url') }]
    },
    registry: {
      apiOrigin: 'https://api.test.invalid',
      activeVersions: { google: snapshot.version },
      registrations: [snapshot]
    },
    google: {
      registrations: [{ version: snapshot.version, tokenEndpoint, jwksUri }],
      secrets: [
        {
          version: snapshot.version,
          reference: snapshot.providerSecretRef,
          value: 'fixture-client-secret'
        }
      ]
    }
  }
}

export async function withRuntimeConfiguration(
  operation,
  configuration = authenticationConfiguration()
) {
  const directory = await mkdtemp(join(tmpdir(), 'ldb-runtime-'))
  const path = join(directory, 'auth.json')
  try {
    await writeFile(path, JSON.stringify(configuration), { mode: 0o600 })
    return await operation({ path, configuration })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function databaseEnvironment(
  configuration = {
    host: '127.0.0.1',
    port: 1,
    username: 'runtime-test',
    password: 'runtime-test-password',
    database: 'runtime-test'
  }
) {
  return {
    DB_HOST: configuration.host,
    DB_PORT: String(configuration.port),
    DB_USERNAME: configuration.username,
    DB_PASSWORD: configuration.password,
    DB_NAME: configuration.database
  }
}

export function startRuntime(
  environment,
  { fault = '', realDatabase = false, upstreams = {} } = {}
) {
  // 실제 환경의 credential·NODE_OPTIONS를 상속하지 않고 명시한 fixture만 전달한다.
  const env = {
    PATH: process.env.PATH,
    ...environment,
    LDB_TEST_RUNTIME_FAULT: fault,
    LDB_TEST_RUNTIME_DATABASE: realDatabase ? 'real' : 'fake',
    LDB_TEST_GOOGLE_ORIGIN: upstreams.google ?? '',
    LDB_TEST_NEOPLE_ORIGIN: upstreams.neople ?? ''
  }
  const child = spawn(
    process.execPath,
    [
      '--import',
      'reflect-metadata',
      '--import',
      './test-support/runtime-preload.mjs',
      'dist/main.js'
    ],
    { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  )
  const events = []
  let stdout = ''
  let stderr = ''
  child.on('message', (message) => events.push(message))
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk
  })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return { child, events, exited }
}

export async function collectRuntimeExit(runtime, timeoutMs = 5000) {
  let timer
  try {
    return await Promise.race([
      runtime.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          runtime.child.kill('SIGKILL')
          reject(new Error('API did not exit within the test deadline'))
        }, timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function stopRuntime(runtime) {
  const isRunning = runtime.child.exitCode === null && runtime.child.signalCode === null
  if (isRunning) {
    runtime.child.kill('SIGKILL')
  }
  await runtime.exited
}

export async function unusedRuntimePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) =>
    server.close((error) => {
      const hasError = error != null
      if (hasError) {
        reject(error)
      } else {
        resolve()
      }
    })
  )
  return port
}

export async function waitForRuntime(port, runtime) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(runtime.child.exitCode, null, 'API exited before listening')
    try {
      await fetch(`http://127.0.0.1:${port}/`)
      return
    } catch {
      await delay(20)
    }
  }
  assert.fail('API did not listen within the test deadline')
}

export function runtimeEnvironment(path, port, database) {
  return {
    ...databaseEnvironment(database),
    AUTH_CONFIG_FILE: path,
    PORT: String(port),
    NEOPLE_API_KEY: 'synthetic-search-key'
  }
}

export function assertStartupFailure(result) {
  assert.equal(result.code, 1)
  assert.equal(result.signal, null)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'API failed to start\n')
}
