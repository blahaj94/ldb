import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runAuthBridgeFixture } from '../auth-bridge-fixture.mjs'

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(),
  remove: vi.fn(),
  inspect: vi.fn(),
  create: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: fixture.spawn }))
vi.mock('node:fs/promises', () => ({
  mkdtemp: fixture.create,
  rm: fixture.remove,
  lstat: fixture.inspect
}))

beforeEach(() => {
  vi.resetAllMocks()
  fixture.create.mockResolvedValue('/synthetic/owned-profile')
  fixture.remove.mockResolvedValue(undefined)
  fixture.inspect.mockRejectedValue(
    Object.assign(new Error('SYNTHETIC_FILE_FAILURE'), { code: 'ENOENT' })
  )
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

it('child 종료와 owned process group 부재 확인 뒤 profile을 삭제하고 부재를 확인한다', async () => {
  expect(await runAuthBridgeFixture(['--smoke'])).toBe(0)
  expect(process.kill).toHaveBeenCalledWith(-424242, 0)
  expect(fixture.remove).toHaveBeenCalledExactlyOnceWith('/synthetic/owned-profile', {
    recursive: true,
    force: true,
    maxRetries: 3
  })
  expect(fixture.inspect).toHaveBeenCalledWith('/synthetic/owned-profile')
  expect(console.log).toHaveBeenCalledExactlyOnceWith('Auth bridge fixture cleanup PASS')
  expect(console.error).not.toHaveBeenCalled()
})

it('child 실패는 cleanup 성공 뒤에도 실패로 반환한다', async () => {
  fixture.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 424242 })
    queueMicrotask(() => child.emit('close', 1))
    return child
  })

  expect(await runAuthBridgeFixture(['--smoke'])).toBe(1)
  expect(console.log).toHaveBeenCalledExactlyOnceWith('Auth bridge fixture cleanup PASS')
})

it('owned process group 종료를 확인하지 못하면 profile을 삭제하지 않고 실패한다', async () => {
  vi.mocked(process.kill).mockImplementation(() => {
    throw Object.assign(new Error('SYNTHETIC_GROUP_FAILURE'), { code: 'EPERM' })
  })

  expect(await runAuthBridgeFixture(['--smoke'])).toBe(1)
  expect(fixture.remove).not.toHaveBeenCalled()
  expect(console.error).toHaveBeenCalledExactlyOnceWith('Auth bridge fixture cleanup FAIL')
  expect(console.log).not.toHaveBeenCalled()
})

it('profile 삭제 또는 부재 확인 실패를 성공으로 숨기지 않는다', async () => {
  fixture.remove.mockRejectedValue(new Error('SYNTHETIC_FILE_FAILURE'))

  expect(await runAuthBridgeFixture(['--smoke'])).toBe(1)
  expect(console.error).toHaveBeenCalledExactlyOnceWith('Auth bridge fixture cleanup FAIL')
  expect(console.log).not.toHaveBeenCalled()
})
