import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

const entryArguments = ['--import', 'reflect-metadata', 'dist/main.js']

function startApi(port?: string): ChildProcessWithoutNullStreams {
  const env: NodeJS.ProcessEnv = {}
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH
  if (port !== undefined) env.PORT = port

  return spawn(process.execPath, entryArguments, {
    cwd: process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

async function collectExit(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}> {
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))

  const { code, signal } = await new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }))
  })

  return { code, signal, stdout, stderr }
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return port
}

async function waitForListening(port: number, child: ChildProcessWithoutNullStreams): Promise<Response> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    assert.equal(child.exitCode, null, 'API exited before it listened')
    try {
      return await fetch(`http://127.0.0.1:${port}/`)
    } catch {
      await delay(20)
    }
  }
  throw new Error('API did not listen in time')
}

test('build entry listens and closes cleanly on SIGTERM', async () => {
  const port = await unusedPort()
  const child = startApi(String(port))

  try {
    const response = await waitForListening(port, child)
    assert.equal(response.status, 404)
    child.kill('SIGTERM')

    const result = await collectExit(child)
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null })
    assert.equal(result.stderr, '')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

test('invalid PORT values fail before listening without exposing configuration', async () => {
  const invalidValues = [undefined, '', '0', '65536', '1.5', '+1', '-1', ' 1', '１']

  for (const value of invalidValues) {
    const result = await collectExit(startApi(value))
    assert.notEqual(result.code, 0)
    assert.equal(result.signal, null)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'API failed to start\n')
    if (value) assert.equal(result.stderr.includes(value), false)
    assert.equal(result.stderr.includes('at '), false)
  }
})

test('a listen failure exits nonzero without exposing the port or stack', async () => {
  const occupiedServer = createServer()
  await new Promise<void>((resolve, reject) => {
    occupiedServer.once('error', reject)
    occupiedServer.listen(0, resolve)
  })
  const port = (occupiedServer.address() as AddressInfo).port

  try {
    const result = await collectExit(startApi(String(port)))
    assert.notEqual(result.code, 0)
    assert.equal(result.signal, null)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'API failed to start\n')
  } finally {
    await new Promise<void>((resolve, reject) =>
      occupiedServer.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
