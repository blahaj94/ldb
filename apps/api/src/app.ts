import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { INestApplication, Type } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'

@Module({})
export class AppModule {}

export function createApp(rootModule: Type = AppModule): Promise<INestApplication> {
  return NestFactory.create(rootModule, { logger: false })
}
