import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  on: vi.fn<(event: string, listener: () => void) => void>(),
  exit: vi.fn<(code: number) => void>(),
  remove: vi.fn(),
  exists: vi.fn()
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  mkdtempSync: () => '/synthetic/capture-fixture-profile',
  rmSync: fixture.remove,
  existsSync: fixture.exists
}))
vi.mock('electron', () => ({
  app: {
    setPath: vi.fn(),
    setName: vi.fn(),
    on: fixture.on,
    whenReady: () => new Promise<void>(() => undefined),
    exit: fixture.exit
  }
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  fixture.remove.mockReset()
  fixture.exists.mockReset()
  fixture.exists.mockReturnValue(false)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

async function quitHandler(): Promise<() => void> {
  await import('./main')
  const registration = fixture.on.mock.calls.find(([event]) => {
    const isQuit = event === 'quit'
    return isQuit
  })
  const hasRegistration = registration != null
  if (!hasRegistration) throw new Error('Fixture quit handler missing')
  return registration[1]
}

it.each(['remove throws', 'profile remains', 'inspection throws'])(
  '%s이면 정제 cleanup FAIL과 nonzero 종료를 보장한다',
  async (failure) => {
    const quit = await quitHandler()
    const isRemoveFailure = failure === 'remove throws'
    const isInspectionFailure = failure === 'inspection throws'
    if (isRemoveFailure)
      fixture.remove.mockImplementation(() => {
        throw new Error('SYNTHETIC_FILE_FAILURE')
      })
    else if (isInspectionFailure)
      fixture.exists.mockImplementation(() => {
        throw new Error('SYNTHETIC_FILE_FAILURE')
      })
    else fixture.exists.mockReturnValue(true)
    fixture.exit.mockImplementation(() => quit())

    expect(quit).not.toThrow()
    expect(console.error).toHaveBeenCalledExactlyOnceWith('Capture fixture cleanup FAIL')
    expect(fixture.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(fixture.remove).toHaveBeenCalledOnce()
    expect(console.log).not.toHaveBeenCalled()
  }
)

it('정상 삭제와 재진입은 cleanup을 한 번만 실행하고 실패 exit를 만들지 않는다', async () => {
  const quit = await quitHandler()
  quit()
  quit()
  expect(fixture.remove).toHaveBeenCalledOnce()
  expect(console.log).toHaveBeenCalledExactlyOnceWith('Capture fixture cleanup PASS')
  expect(console.error).not.toHaveBeenCalled()
  expect(fixture.exit).not.toHaveBeenCalled()
})
