/* global AbortController */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { createDatabaseDataSource } from '../dist/database/index.js'
import { bounded, settled } from './login-test-control.mjs'

test('search abort closes a PostgreSQL connection still waiting for authentication', async () => {
  const { createSearchQueryRunner } = await import('../dist/characters/search-query-runner.js')
  const sockets = new Set()
  let connected
  let disconnected
  const connection = new Promise((resolve) => { connected = resolve })
  const disconnection = new Promise((resolve) => { disconnected = resolve })
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      disconnected()
    })
    socket.on('data', () => undefined)
    connected()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const source = createDatabaseDataSource({
    host: '127.0.0.1', port: server.address().port,
    username: 'synthetic', password: 'synthetic', database: 'synthetic',
  })
  const controller = new AbortController()
  const runner = createSearchQueryRunner(source, controller.signal)
  try {
    const connecting = settled(runner.connect())
    await bounded(connection)
    controller.abort()
    assert((await bounded(connecting)).error)
    await bounded(runner.release())
    await bounded(disconnection)
    assert.equal(sockets.size, 0)
    assert.equal(runner.isReleased, true)
    await assert.rejects(runner.query('SELECT 1'))
  } finally {
    controller.abort()
    await runner.release()
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('search pre-aborted connection never opens a socket', async () => {
  const { createSearchQueryRunner } = await import('../dist/characters/search-query-runner.js')
  const controller = new AbortController()
  controller.abort()
  const source = createDatabaseDataSource({
    host: '127.0.0.1', port: 1,
    username: 'synthetic', password: 'synthetic', database: 'synthetic',
  })
  const runner = createSearchQueryRunner(source, controller.signal)
  await assert.rejects(runner.connect())
  await runner.release()
  assert.equal(runner.isReleased, true)
})
