import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ setPath: vi.fn(), ready: vi.fn(), exit: vi.fn() }))
vi.mock('electron', () => ({
  app: {
    setPath: fixture.setPath,
    setName: vi.fn(),
    on: vi.fn(),
    whenReady: fixture.ready,
    exit: fixture.exit
  }
}))
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fixture.ready.mockReturnValue(new Promise<void>(() => undefined))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubEnv('LDB_AUTH_CAPTURE_PROFILE', undefined)
  vi.stubEnv('LDB_AUTH_CAPTURE_LAUNCHER_PID', undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it.each(['missing owner', 'wrong parent', 'outside temp directory'])(
  '%s인 직접 Electron child는 profile 사용 전에 거절한다',
  async (mode) => {
    const hasWrongParent = mode === 'wrong parent'
    const hasWrongDirectory = mode === 'outside temp directory'
    if (hasWrongParent) {
      vi.stubEnv('LDB_AUTH_CAPTURE_PROFILE', join(tmpdir(), 'ldb-auth-capture-fixture-unit01'))
      vi.stubEnv('LDB_AUTH_CAPTURE_LAUNCHER_PID', '0')
    }
    if (hasWrongDirectory) {
      vi.stubEnv('LDB_AUTH_CAPTURE_PROFILE', '/synthetic/outside-profile')
      vi.stubEnv('LDB_AUTH_CAPTURE_LAUNCHER_PID', String(process.ppid))
    }
    await import('./main')
    expect(fixture.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      'Capture fixture requires the Node launcher'
    )
    expect(fixture.setPath).not.toHaveBeenCalled()
    expect(fixture.ready).not.toHaveBeenCalled()
  }
)
it('launcher가 지정한 profile만 사용하고 종료 후 삭제는 launcher에 맡긴다', async () => {
  const profile = join(tmpdir(), 'ldb-auth-capture-fixture-unit01')
  vi.stubEnv('LDB_AUTH_CAPTURE_PROFILE', profile)
  vi.stubEnv('LDB_AUTH_CAPTURE_LAUNCHER_PID', String(process.ppid))
  await import('./main')
  expect(fixture.setPath).toHaveBeenCalledExactlyOnceWith('userData', profile)
  expect(fixture.ready).toHaveBeenCalledOnce()
  expect(fixture.exit).not.toHaveBeenCalled()
})
