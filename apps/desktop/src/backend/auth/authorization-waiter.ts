import type { AuthAuthorization } from './types'

export function waitForAuthorization(
  operation: () => Promise<AuthAuthorization>,
  signal?: AbortSignal
): Promise<AuthAuthorization> {
  const hasSignal = signal != null
  if (!hasSignal) {
    return operation()
  }
  if (signal.aborted) {
    return Promise.resolve({ status: 'unavailable' })
  }

  return new Promise((resolve, reject) => {
    const cancelWaiter = (): void => resolve({ status: 'unavailable' })
    signal.addEventListener('abort', cancelWaiter, { once: true })
    // Caller의 signal은 공유 작업에 전달하지 않고 이 결과 대기에만 적용한다.
    void operation().then(
      (result) => {
        signal.removeEventListener('abort', cancelWaiter)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener('abort', cancelWaiter)
        reject(error)
      }
    )
  })
}
