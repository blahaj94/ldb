import assert from 'node:assert/strict'
import { createConnection, createServer } from 'node:net'
import { performance } from 'node:perf_hooks'
import { clearInterval, setInterval } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { bounded } from './login-test-control.mjs'
import {
  assertStartupFailure,
  collectRuntimeExit,
  runtimeEnvironment,
  startRuntime,
  stopRuntime,
  unusedRuntimePort,
  withRuntimeConfiguration
} from './runtime-fixtures.mjs'

async function assertPortClosed(port) {
  const client = createConnection({ port, host: '127.0.0.1' })
  try {
    const connected = await bounded(
      new Promise((resolve) => {
        client.once('connect', () => resolve(true))
        client.once('error', () => resolve(false))
      })
    )
    assert.equal(connected, false, 'API must not listen during the stalled database handshake')
  } finally {
    client.destroy()
  }
}

for (const [signal, repeat] of [
  ['SIGINT', false],
  ['SIGTERM', false],
  ['SIGTERM', true]
]) {
  const variant = repeat ? 'with repeated signals' : 'once'
  test(`startup ${signal} ${variant} terminates a stalled real TCP handshake`, async () => {
    const handshake = Promise.withResolvers()
    const closed = Promise.withResolvers()
    const sockets = new Set()
    // PostgreSQL engine이 아닌 TCP peer다. Startup bytes를 읽고 응답 없이 계속 보류한다.
    const peer = createServer((socket) => {
      sockets.add(socket)
      socket.on('data', () => handshake.resolve())
      socket.once('close', () => {
        sockets.delete(socket)
        closed.resolve()
      })
    })
    await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve))
    let runtime
    let repeatedSignals
    try {
      await withRuntimeConfiguration(async ({ path }) => {
        const port = await unusedRuntimePort()
        const configuration = {
          host: '127.0.0.1',
          port: peer.address().port,
          username: 'fixture-handshake-user',
          password: 'fixture-handshake-secret',
          database: 'fixture-handshake-db'
        }
        // 실제 TypeORM/pg initialize를 사용하며 신호로 Promise를 resolve하지 않는다.
        runtime = startRuntime(runtimeEnvironment(path, port, configuration), {
          realDatabase: true
        })
        await bounded(handshake.promise)
        assert.equal(sockets.size, 1)
        await assertPortClosed(port)
        const startedAt = performance.now()
        runtime.child.kill(signal)
        if (repeat) {
          repeatedSignals = setInterval(() => runtime.child.kill('SIGINT'), 100)
        }
        const result = await collectRuntimeExit(runtime, 2000)
        const elapsed = performance.now() - startedAt
        clearInterval(repeatedSignals)
        assertStartupFailure(result)
        assert(elapsed >= 900, 'the first startup signal must allow its cleanup grace')
        assert(elapsed < 2000, 'later signals must not postpone startup termination')
        // Fixture가 peer/socket을 닫기 전에 child exit로 연결이 끝났는지 확인한다.
        await bounded(closed.promise)
        assert.equal(sockets.size, 0)
        await assertPortClosed(port)
        const events = runtime.events.map(({ event }) => event)
        assert.equal(events.includes('db.initialize'), true)
        assert.equal(events.includes('app.listen'), false)
        assert.equal(
          events.includes('db.disconnected'),
          false,
          'native exit is not successful async DB cleanup'
        )
      })
    } finally {
      clearInterval(repeatedSignals)
      const hasRuntime = runtime !== undefined
      if (hasRuntime) {
        await stopRuntime(runtime)
      }
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise((resolve) => peer.close(resolve))
    }
  })
}

test('completed startup shutdown clears its timer while another test handle stays alive', async () => {
  await withRuntimeConfiguration(async ({ path }) => {
    const runtime = startRuntime(runtimeEnvironment(path, await unusedRuntimePort()), {
      fault: 'initialize-signal-hold'
    })
    try {
      let isInitializing = false
      for (let attempt = 0; attempt < 200; attempt += 1) {
        isInitializing = runtime.events.some(({ event }) => event === 'db.initializing')
        if (isInitializing) {
          break
        }
        assert.equal(runtime.child.exitCode, null)
        await delay(10)
      }
      assert(isInitializing)
      runtime.child.kill('SIGTERM')
      const result = await collectRuntimeExit(runtime, 2500)
      assert.deepEqual(result, { code: 0, signal: null, stdout: '', stderr: '' })
      const events = runtime.events.map(({ event }) => event)
      assert.equal(events.includes('app.listen'), false)
      assert.deepEqual(events.slice(-5), [
        'app.close',
        'app.closed',
        'db.destroy',
        'db.disconnected',
        'test.keepalive-finished'
      ])
    } finally {
      await stopRuntime(runtime)
    }
  })
})
