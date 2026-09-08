import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { INestApplication, Type } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'

@Module({})
export class AppModule {}

export function createApp(rootModule: Type = AppModule): Promise<INestApplication> {
  return NestFactory.create(rootModule, { logger: false })
}

export async function closeApp(app: INestApplication): Promise<void> {
  try {
    await app.close()
  } catch {
    console.error(closeApp.startupError)
    process.exitCode = 1
  }
}

closeApp.startupError = 'API failed to start' as const
