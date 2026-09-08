import type { DataSource } from 'typeorm'
import { cleanupAuthentication } from './index.js'
import type { CleanupResult } from './index.js'
import { cleanupFailure } from './errors.js'

export async function runAuthenticationCleanup(
  createDataSource: () => DataSource
): Promise<CleanupResult> {
  let source: DataSource | undefined
  let result: CleanupResult | undefined
  let failed = false
  try {
    source = createDataSource()
    await source.initialize()
    result = await cleanupAuthentication(source)
  } catch {
    failed = true
  }

  const ownedSource = source
  const hasSource = ownedSource != null
  if (hasSource) {
    try {
      // initialize 완료 표시 전에도 driver가 연결을 확보했을 수 있다.
      if (ownedSource.isInitialized) {
        await ownedSource.destroy()
      } else {
        await ownedSource.driver.disconnect()
      }
    } catch {
      failed = true
    }
  }
  const completedResult = result
  const hasResult = completedResult != null
  const cannotConfirmSuccess = failed || !hasResult
  if (cannotConfirmSuccess) {
    throw cleanupFailure()
  }
  return completedResult
}
