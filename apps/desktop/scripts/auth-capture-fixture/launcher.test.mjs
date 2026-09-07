import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runCaptureFixture } from '../auth-capture-fixture.mjs'

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(),
  remove: vi.fn(),
  inspect: vi.fn(),
  create: vi.fn(),
  write: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: fixture.spawn }))
vi.mock('node:fs/promises', () => ({
  mkdtemp: fixture.create,
  rm: fixture.remove,
  lstat: fixture.inspect,
  writeFile: fixture.write
}))
beforeEach(() => {
  vi.resetAllMocks()
  fixture.create.mockResolvedValue('/synthetic/owned-profile')
  fixture.remove.mockResolvedValue(undefined)
  fixture.inspect.mockRejectedValue(
    Object.assign(new Error('SYNTHETIC_FILE_FAILURE'), { code: 'ENOENT' })
  )
  fixture.write.mockResolvedValue(undefined)
  fixture.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 424242 })
    queueMicrotask(() => child.emit('close', 0))
    return child
  })
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Gone'), { code: 'ESRCH' })
  })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it.each(['remove throws', 'profile remains', 'inspection throws'])(
  '%s이면 child 성공도 정제 cleanup FAIL과 nonzero로 끝낸다',
  async (failure) => {
    const isRemoveFailure = failure === 'remove throws'
    const isInspectionFailure = failure === 'inspection throws'
    if (isRemoveFailure) fixture.remove.mockRejectedValue(new Error('SYNTHETIC_FILE_FAILURE'))
    else if (isInspectionFailure)
      fixture.inspect.mockRejectedValue(new Error('SYNTHETIC_FILE_FAILURE'))
    else fixture.inspect.mockResolvedValue({})
    expect(await runCaptureFixture(['--ocr'])).toBe(1)
    expect(console.error).toHaveBeenCalledExactlyOnceWith('Capture fixture cleanup FAIL')
    expect(console.log).not.toHaveBeenCalled()
    expect(fixture.remove).toHaveBeenCalledOnce()
  }
)
it('child/group 종료 확인 후 한 번 삭제하고 부재를 확인한다', async () => {
  expect(await runCaptureFixture(['--ocr'])).toBe(0)
  expect(process.kill).toHaveBeenCalledWith(-424242, 0)
  expect(fixture.remove).toHaveBeenCalledExactlyOnceWith('/synthetic/owned-profile', {
    recursive: true,
    force: true,
    maxRetries: 3
  })
  expect(fixture.inspect).toHaveBeenCalledWith('/synthetic/owned-profile')
  expect(console.log).toHaveBeenCalledExactlyOnceWith('Capture fixture cleanup PASS')
  expect(console.error).not.toHaveBeenCalled()
})
it('child 실패 종료 code는 cleanup 성공 뒤에도 성공으로 바꾸지 않는다', async () => {
  fixture.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 424242 })
    queueMicrotask(() => child.emit('close', 1))
    return child
  })
  expect(await runCaptureFixture(['--smoke'])).toBe(1)
  expect(console.log).toHaveBeenCalledExactlyOnceWith('Capture fixture cleanup PASS')
})

it('child를 시작하지 못해도 자기 profile은 정리하고 raw spawn 오류를 노출하지 않는다', async () => {
  fixture.spawn.mockImplementation(() => {
    throw new Error('SYNTHETIC_SPAWN_FAILURE')
  })
  expect(await runCaptureFixture(['--ocr'])).toBe(1)
  expect(fixture.remove).toHaveBeenCalledOnce()
  expect(console.error).toHaveBeenCalledExactlyOnceWith('Capture fixture launcher execution FAIL')
  expect(console.log).toHaveBeenCalledExactlyOnceWith('Capture fixture cleanup PASS')
})
it('owned group 종료가 확인되지 않으면 profile을 삭제하지 않고 실패한다', async () => {
  vi.mocked(process.kill).mockImplementation(() => {
    throw Object.assign(new Error('SYNTHETIC_GROUP_FAILURE'), { code: 'EPERM' })
  })
  expect(await runCaptureFixture(['--ocr'])).toBe(1)
  expect(fixture.remove).not.toHaveBeenCalled()
  expect(console.error).toHaveBeenCalledExactlyOnceWith('Capture fixture cleanup FAIL')
  expect(console.log).not.toHaveBeenCalled()
})
