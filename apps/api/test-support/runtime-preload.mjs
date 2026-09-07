/* global fetch, URL */
import assert from 'node:assert/strict'
import process from 'node:process'
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
  this.driver.disconnect = async () => { observe('db.disconnected') }
  if (shouldFailPartially) throw new Error('fixture-sensitive-partial-connect')
  this.isInitialized = true
  return this
}
DataSource.prototype.destroy = async function () {
  observe('db.destroy')
  if (useRealDatabase) return destroy.call(this)
  this.isInitialized = false
  observe('db.disconnected')
}

const create = NestFactory.create.bind(NestFactory)
NestFactory.create = async (...args) => {
  observe('app.create')
  const shouldFailCreation = fault === 'app-create'
  if (shouldFailCreation) throw new Error('fixture-sensitive-app-creation')
  const shouldFailProvider = fault === 'nest-provider'
  if (shouldFailProvider) {
    class FaultyModule {}
    Module({ providers: [{
      provide: 'runtime-test-failure',
      useFactory: () => { throw new Error('fixture-sensitive-nest-provider') },
    }] })(FaultyModule)
    args[0] = FaultyModule
  }
  const app = await create(...args)
  const close = app.close.bind(app)
  const observedClose = async () => {
    observe('app.close')
    await close()
    observe('app.closed')
    const shouldFailClose = fault === 'app-close'
    if (shouldFailClose) throw new Error('fixture-sensitive-app-close')
  }
  const shouldFailConfiguration = fault === 'app-configure'
  const listen = app.listen.bind(app)
  const observedListen = async (...listenArgs) => {
    observe('app.listen')
    const shouldStopBeforeListening = fault === 'stop-before-listen'
    if (shouldStopBeforeListening) throw new Error('fixture-sensitive-unexpected-listen')
    return listen(...listenArgs)
  }
  // Nest의 내부 proxy는 set을 무시하므로 바깥 get proxy로 관측한다.
  return new Proxy(app, {
    get(target, property) {
      const isClose = property === 'close'
      const isListen = property === 'listen'
      const isFailingUse = shouldFailConfiguration && property === 'use'
      if (isClose) return observedClose
      if (isListen) return observedListen
      if (isFailingUse) return () => { throw new Error('fixture-sensitive-app-configuration') }
      return Reflect.get(target, property)
    },
  })
}

const nativeFetch = fetch
globalThis.fetch = (input, options) => {
  const url = new URL(input)
  const isTokenRequest = url.href === tokenEndpoint
  const isKeysRequest = url.href === jwksUri
  const isGoogleRequest = isTokenRequest || isKeysRequest
  const isNeopleRequest = url.origin === 'https://api.neople.co.kr'
  // 정의하지 않은 외부 연결은 거절한다. Test transport만 loopback URL에 대응시킨다.
  assert(isGoogleRequest || isNeopleRequest, 'unexpected outbound request in runtime test')
  if (isGoogleRequest) {
    return nativeFetch(`${process.env.LDB_TEST_GOOGLE_ORIGIN}${isTokenRequest ? '/token' : '/certs'}`, options)
  }
  return nativeFetch(`${process.env.LDB_TEST_NEOPLE_ORIGIN}${url.pathname}${url.search}`, options)
}
