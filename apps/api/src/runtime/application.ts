import type { INestApplication } from '@nestjs/common'
import { createLoginHttpApp, createSessionHttpService } from '../auth/login/http.js'
import { createLoginService } from '../auth/login/service.js'
import { createDatabaseDataSource } from '../database/index.js'
import type { readRuntimeConfiguration } from './configuration.js'

type RuntimeConfiguration = Awaited<ReturnType<typeof readRuntimeConfiguration>>

/** 이번 실행이 소유한 앱과 DataSource의 종료 책임을 함께 관리한다. */
export async function createApiRuntime(configuration: RuntimeConfiguration) {
  const dataSource = createDatabaseDataSource(configuration.database)
  let app: INestApplication | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    const pendingClose = closing
    const isClosing = pendingClose !== undefined
    if (isClosing) {
      return pendingClose
    }
    const ownedApp = app
    closing = (async () => {
      let failed = false
      const hasApp = ownedApp !== undefined
      if (hasApp) {
        try {
          await ownedApp.close()
        } catch {
          failed = true
        }
      }
      try {
        const isInitialized = dataSource.isInitialized
        if (isInitialized) {
          await dataSource.destroy()
        }
        // Driver connect 중 실패하면 isInitialized=false여도 pool이 남을 수 있다.
        else {
          await dataSource.driver.disconnect()
        }
      } catch {
        failed = true
      }
      if (failed) {
        throw new Error('API runtime cleanup failed')
      }
    })()
    return closing
  }

  try {
    await dataSource.initialize()
    const login = createLoginService({
      dataSource,
      registry: configuration.registry,
      pkceKeys: configuration.pkceKeys,
      issueAccessJwt: configuration.issueAccessJwt,
      verifyProvider: configuration.verifyProvider
    })
    const session = createSessionHttpService({
      dataSource,
      issueAccessJwt: configuration.issueAccessJwt
    })
    const account = { dataSource, verifyAccessJwt: configuration.verifyAccessJwt }
    app = await createLoginHttpApp(login, session, account, {
      ...account,
      apiKey: configuration.apiKey
    })
    return { app, close }
  } catch (error) {
    // 초기화 실패를 보존하며 앱을 얻지 못했거나 close가 실패해도 DB 정리를 시도한다.
    await close().catch(() => undefined)
    throw error
  }
}
