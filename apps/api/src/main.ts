import 'reflect-metadata'
import { writeSync } from 'node:fs'
import { closeApp } from './app.js'
import { createApiRuntime } from './runtime/application.js'
import { readRuntimeConfiguration } from './runtime/configuration.js'

const startupShutdownGraceMs = 1000

async function main(): Promise<void> {
  const configuration = await readRuntimeConfiguration(process.env)
  let runtime: Awaited<ReturnType<typeof createApiRuntime>> | undefined
  let stopping = false
  let starting = true
  let startupShutdownTimer: ReturnType<typeof setTimeout> | undefined
  let closing: Promise<void> | undefined
  const close = (ownedRuntime: Awaited<ReturnType<typeof createApiRuntime>>): Promise<void> => {
    const pendingClose = closing
    const isClosing = pendingClose !== undefined
    if (isClosing) {
      return pendingClose
    }
    closing = ownedRuntime
      .close()
      .catch(() => {
        console.error(closeApp.startupError)
        process.exitCode = 1
      })
      .finally(() => {
        clearTimeout(startupShutdownTimer)
        process.off('SIGINT', shutdown)
        process.off('SIGTERM', shutdown)
      })
    return closing
  }
  const shutdown = (): void => {
    const isFirstSignal = !stopping
    const shouldLimitStartup = starting && isFirstSignal
    stopping = true
    if (shouldLimitStartup) {
      startupShutdownTimer = setTimeout(() => {
        // Pending handshake는 driver에 취소 경로가 없다. Async 정리 완료와 구분한다.
        try {
          writeSync(2, `${closeApp.startupError}\n`)
        } finally {
          process.exit(1)
        }
      }, startupShutdownGraceMs)
    }
    const ownedRuntime = runtime
    const hasRuntime = ownedRuntime !== undefined
    const canClose = hasRuntime && !starting
    if (canClose) {
      void close(ownedRuntime)
    }
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  try {
    runtime = await createApiRuntime(configuration)
    // 초기화 중 signal이 오면 완료 뒤 port를 열지 않고 소유 자원을 정리한다.
    if (stopping) {
      starting = false
      await close(runtime)
      return
    }
    await runtime.app.listen(configuration.port)
    starting = false
    if (stopping) {
      await close(runtime)
    }
  } catch (error) {
    starting = false
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    const ownedRuntime = runtime
    const hasRuntime = ownedRuntime !== undefined
    if (hasRuntime) {
      await close(ownedRuntime)
    }
    clearTimeout(startupShutdownTimer)
    throw error
  }
}

try {
  await main()
} catch {
  console.error(closeApp.startupError)
  process.exitCode = 1
}
