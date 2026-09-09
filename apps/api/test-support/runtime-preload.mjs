import assert from 'node:assert/strict'
import process from 'node:process'
import { once } from 'node:events'
import { clearTimeout, setTimeout } from 'node:timers'
import { DataSource } from 'typeorm'
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import { jwksUri, tokenEndpoint } from './google-fixtures.mjs'

// Test child의 --import에만 지정하며 제품 entry는 이 module을 import하지 않는다.
const fault = process.env.LDB_TEST_RUNTIME_FAULT
const useRealDatabase = process.env.LDB_TEST_RUNTIME_DATABASE === 'real'
const observe = (event, detail) => process.send?.({ event, detail })
const initialize = DataSource.prototype.initialize
const destroy = DataSource.prototype.destroy
DataSource.prototype.initialize = async function () {
  observe('db.initialize')
  const shouldFailPartially = fault === 'partial-connect'
  if (useRealDatabase) {
    const disconnect = this.driver.disconnect.bind(this.driver)
    this.driver.disconnect = async () => {
      await disconnect()
      observe('db.disconnected')
    }
    if (shouldFailPartially) {
      const createQueryRunner = this.driver.createQueryRunner.bind(this.driver)
      this.driver.createQueryRunner = (...args) => {
        const runner = createQueryRunner(...args)
        runner.getVersion = async () => {
          const [row] = await runner.query('SELECT pg_backend_pid() AS pid')
          observe('db.backend', row.pid)
          throw new Error('fixture-sensitive-introspection-failure')
        }
        return runner
      }
    }
    const result = await initialize.call(this)
    const [row] = await this.query('SELECT pg_backend_pid() AS pid')
    observe('db.backend', row.pid)
    return result
  }
  this.driver.disconnect = async () => {
    observe('db.disconnected')
  }
  if (shouldFailPartially) {
    throw new Error('fixture-sensitive-partial-connect')
  }
  const shouldWaitDuringInitialization = fault === 'initialize-signal'
  const shouldWaitAndHoldAfterCleanup =
    !shouldWaitDuringInitialization && fault === 'initialize-signal-hold'
  const shouldWaitForSignal = shouldWaitDuringInitialization || shouldWaitAndHoldAfterCleanup
  if (shouldWaitForSignal) {
    // 실제 connecting socket을 대신하는 ref를 유지해야 Node가 await 중 종료하지 않는다.
    const connectionHandle = setTimeout(() => {}, 5000)
    const signalled = once(process, 'SIGTERM')
    observe('db.initializing')
    try {
      await signalled
    } finally {
      clearTimeout(connectionHandle)
    }
  }
  this.isInitialized = true
  return this
}
DataSource.prototype.destroy = async function () {
  observe('db.destroy')
  if (useRealDatabase) {
    return destroy.call(this)
  }
  this.isInitialized = false
  observe('db.disconnected')
  const shouldHoldAfterCleanup = fault === 'initialize-signal-hold'
  if (shouldHoldAfterCleanup) {
    // 정리 뒤에도 test 소유 handle을 남겨 취소되지 않은 시작 종료 timer를 관측한다.
    setTimeout(() => observe('test.keepalive-finished'), 1300)
  }
}

const create = NestFactory.create.bind(NestFactory)
NestFactory.create = async (...args) => {
  observe('app.create')
  const shouldFailCreation = fault === 'app-create'
  if (shouldFailCreation) {
    throw new Error('fixture-sensitive-app-creation')
  }
  const shouldFailProvider = fault === 'nest-provider'
  if (shouldFailProvider) {
    class FaultyModule {}
    Module({
      providers: [
        {
          provide: 'runtime-test-failure',
          useFactory: () => {
            throw new Error('fixture-sensitive-nest-provider')
          }
        }
      ]
    })(FaultyModule)
    args[0] = FaultyModule
  }
  const app = await create(...args)
  const close = app.close.bind(app)
  const observedClose = async () => {
    observe('app.close')
    await close()
    observe('app.closed')
    const shouldFailClose = fault === 'app-close'
    if (shouldFailClose) {
      throw new Error('fixture-sensitive-app-close')
    }
  }
  const shouldFailConfiguration = fault === 'app-configure'
  const listen = app.listen.bind(app)
  const observedListen = async (...listenArgs) => {
    observe('app.listen')
    const shouldStopBeforeListening = fault === 'stop-before-listen'
    if (shouldStopBeforeListening) {
      throw new Error('fixture-sensitive-unexpected-listen')
    }
    const result = await listen(...listenArgs)
    const shouldWaitForSignal = fault === 'listen-signal'
    if (shouldWaitForSignal) {
      const signalled = once(process, 'SIGTERM')
      observe('app.listen-pending')
      await signalled
    }
    return result
  }
  // Nest의 내부 proxy는 set을 무시하므로 바깥 get proxy로 관측한다.
  return new Proxy(app, {
    get(target, property) {
      const isClose = property === 'close'
      const isListen = property === 'listen'
      const isFailingUse = shouldFailConfiguration && property === 'use'
      if (isClose) {
        return observedClose
      }
      if (isListen) {
        return observedListen
      }
      if (isFailingUse) {
        return () => {
          throw new Error('fixture-sensitive-app-configuration')
        }
      }
      return Reflect.get(target, property)
    }
  })
}

const nativeFetch = fetch
globalThis.fetch = (input, options) => {
  const url = new URL(input)
  const isTokenRequest = url.href === tokenEndpoint
  const isKeysRequest = url.href === jwksUri
  const isGoogleRequest = isTokenRequest || isKeysRequest
  const isNeopleRequest = url.origin === 'https://api.neople.co.kr'
  const isExpectedOutboundRequest = isGoogleRequest || isNeopleRequest
  // 정의하지 않은 외부 연결은 거절한다. Test transport만 loopback URL에 대응시킨다.
  assert(isExpectedOutboundRequest, 'unexpected outbound request in runtime test')
  if (isGoogleRequest) {
    const path = isTokenRequest ? '/token' : '/certs'
    return nativeFetch(`${process.env.LDB_TEST_GOOGLE_ORIGIN}${path}`, options)
  }
  return nativeFetch(`${process.env.LDB_TEST_NEOPLE_ORIGIN}${url.pathname}${url.search}`, options)
}
