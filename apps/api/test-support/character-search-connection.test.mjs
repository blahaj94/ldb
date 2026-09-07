/* global AbortController */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from 'pg'
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
  const nativeConnect = Client.prototype.connect
  let emitLateError
  let lateCallback
  Client.prototype.connect = function (callback) {
    emitLateError = () => this.emit('error', new Error('synthetic late connection error'))
    lateCallback = callback
    return nativeConnect.call(this, callback)
  }
  const runner = createSearchQueryRunner(source, controller.signal)
  try {
    const connecting = settled(runner.connect())
    await bounded(connection)
    controller.abort()
    assert((await bounded(connecting)).error)
    emitLateError()
    lateCallback()
    await bounded(runner.release())
    await bounded(disconnection)
    assert.equal(sockets.size, 0)
    assert.equal(runner.isReleased, true)
    await assert.rejects(runner.query('SELECT 1'))
  } finally {
    Client.prototype.connect = nativeConnect
    controller.abort()
    await runner.release()
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('search pre-aborted connection never opens a socket', async () => {
  const { createSearchQueryRunner } = await import('../dist/characters/search-query-runner.js')
  let connections = 0
  const server = createServer((socket) => {
    connections += 1
    socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const controller = new AbortController()
  controller.abort()
  const source = createDatabaseDataSource({
    host: '127.0.0.1', port: server.address().port,
    username: 'synthetic', password: 'synthetic', database: 'synthetic',
  })
  const runner = createSearchQueryRunner(source, controller.signal)
  try {
    await assert.rejects(runner.connect())
    await runner.release()
    await delay(20)
    assert.equal(connections, 0)
    assert.equal(runner.isReleased, true)
  } finally {
    await runner.release()
    await new Promise((resolve) => server.close(resolve))
  }
})
