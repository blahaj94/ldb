import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { after, before, test } from 'node:test'
import { Controller, Get, Injectable, Module } from '@nestjs/common'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { createApp } from '../src/app.js'

@Injectable()
class GreetingService {
  message(): string {
    return 'hello'
  }
}

@Controller()
class TestController {
  constructor(private readonly greetingService: GreetingService) {}

  @Get('test')
  getMessage(): string {
    return this.greetingService.message()
  }
}

@Module({ controllers: [TestController], providers: [GreetingService] })
class TestModule {}

let app: INestApplication
let baseUrl: string

before(async () => {
  app = await createApp(TestModule)
  await app.listen(0, '127.0.0.1')
  const server = app.getHttpServer() as Server
  const address = server.address()
  assert(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  const server = app.getHttpServer() as Server
  await app.close()
  assert.equal(server.listening, false)
})

test('Nest testing container resolves constructor metadata and overrides a provider', async () => {
  assert.deepEqual(Reflect.getMetadata('design:paramtypes', TestController), [GreetingService])
  const testingModule = await Test.createTestingModule({
    controllers: [TestController],
    providers: [GreetingService],
  })
    .overrideProvider(GreetingService)
    .useValue({ message: () => 'overridden' })
    .compile()

  try {
    assert.equal(testingModule.get(TestController).getMessage(), 'overridden')
  } finally {
    await testingModule.close()
  }
})

test('app factory serves an actual HTTP response', async () => {
  const response = await fetch(`${baseUrl}/test`)

  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'hello')
})
