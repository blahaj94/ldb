import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import { createApp } from './app.js'
import { parsePort } from './port.js'

const startupError = 'API failed to start'

async function closeApp(app: INestApplication): Promise<void> {
  try {
    await app.close()
  } catch {
    console.error(startupError)
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  const port = parsePort(process.env.PORT)
  const app = await createApp()
  const shutdown = (): void => {
    void closeApp(app)
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  try {
    await app.listen(port)
  } catch (error) {
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    await closeApp(app)
    throw error
  }
}

try {
  await main()
} catch {
  console.error(startupError)
  process.exitCode = 1
}
