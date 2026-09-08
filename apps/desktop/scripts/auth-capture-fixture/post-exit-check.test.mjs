import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(),
  create: vi.fn(),
  read: vi.fn(),
  remove: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: fixture.spawn }))
vi.mock('node:fs/promises', () => ({
  mkdtemp: fixture.create,
  readdir: fixture.read,
  rm: fixture.remove
}))
let originalExitCode
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  originalExitCode = process.exitCode
  process.exitCode = 0
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'post-exit-check.mjs', '--media'])
  fixture.create.mockResolvedValue('/synthetic/owned-exit-check')
  fixture.read.mockResolvedValue([])
  fixture.remove.mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('60초 이후 내부 실행과 정리를 마친 정상 child를 outer timeout이 조기 종료하지 않는다', async () => {
  let hasExited = false
  const child = Object.assign(new EventEmitter(), {
    pid: 424242,
    stdout: new EventEmitter(),
    stderr: new EventEmitter()
  })
  fixture.spawn.mockImplementation(() => {
    setTimeout(() => {
      child.stdout.emit('data', 'Capture fixture smoke PASS')
      hasExited = true
      child.emit('close', 0)
    }, 125_000)
    return child
  })
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    const isInspection = signal === 0
    if (isInspection) {
      if (hasExited) throw Object.assign(new Error('Gone'), { code: 'ESRCH' })
      return true
    }
    hasExited = true
    child.emit('close', 1)
    return true
  })
  const execution = import('./post-exit-check.mjs')
  await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledOnce())

  await vi.advanceTimersByTimeAsync(125_000)
  await execution

  expect(process.kill).not.toHaveBeenCalledWith(-424242, 'SIGTERM')
  expect(console.log).toHaveBeenCalledWith('Capture fixture post-exit check PASS')
  expect(process.exitCode).toBe(0)
  expect(fixture.remove).toHaveBeenCalledExactlyOnceWith('/synthetic/owned-exit-check', {
    recursive: true,
    force: true,
    maxRetries: 3
  })
})
