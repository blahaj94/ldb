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

/** @returns {{ deliver: (signal: string) => void, unhandled: () => number, count: () => number }} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- JSDoc carries the JavaScript return type.
function captureSignals() {
  const handlers = new Map()
  let unhandled = 0
  const originalOn = process.on.bind(process)
  const originalOnce = process.once.bind(process)
  const originalRemove = process.removeListener.bind(process)
  for (const [method, original] of [
    ['on', originalOn],
    ['once', originalOnce]
  ]) {
    vi.spyOn(process, method).mockImplementation((event, listener) => {
      const isSignal = event === 'SIGINT' || event === 'SIGTERM'
      if (!isSignal) return original(event, listener)
      handlers.set(event, { listener, once: method === 'once' })
      return process
    })
  }
  vi.spyOn(process, 'removeListener').mockImplementation((event, listener) => {
    const registration = handlers.get(event)
    const isRegistered = registration != null && registration.listener === listener
    if (isRegistered) handlers.delete(event)
    else originalRemove(event, listener)
    return process
  })
  return {
    deliver: (signal) => {
      const registration = handlers.get(signal)
      const isUnhandled = registration == null
      if (isUnhandled) {
        // 실제 Vitest process를 종료하지 않고 기본 OS 종료로 빠지는 전달을 기록한다.
        unhandled += 1
        return
      }
      if (registration.once) handlers.delete(signal)
      registration.listener()
    },
    unhandled: () => unhandled,
    count: () => handlers.size
  }
}

it.each(['profile creation', 'owner write'])(
  '%s 대기 중 반복 신호는 child를 시작하지 않고 profile 정리를 마친다',
  async (stage) => {
    const signals = captureSignals()
    const pending = Promise.withResolvers()
    const isCreatingProfile = stage === 'profile creation'
    const operation = isCreatingProfile ? fixture.create : fixture.write
    operation.mockReturnValue(pending.promise)
    const result = runCaptureFixture(['--ocr'])
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce())

    signals.deliver('SIGTERM')
    signals.deliver('SIGTERM')
    pending.resolve(isCreatingProfile ? '/synthetic/owned-profile' : undefined)

    expect(await result).toBe(1)
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.remove).toHaveBeenCalledOnce()
    expect(fixture.inspect).toHaveBeenCalledOnce()
    expect(process.kill).not.toHaveBeenCalled()
    expect(signals.unhandled()).toBe(0)
    expect(signals.count()).toBe(0)
  }
)

it.each(['profile removal', 'absence inspection'])(
  '%s 대기 중 반복 신호는 정리를 마치고 nonzero로 끝내며 종료 group에 신호를 보내지 않는다',
  async (stage) => {
    const signals = captureSignals()
    const pending = Promise.withResolvers()
    const isRemovingProfile = stage === 'profile removal'
    const operation = isRemovingProfile ? fixture.remove : fixture.inspect
    operation.mockReturnValue(pending.promise)
    const result = runCaptureFixture(['--ocr'])
    await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce())

    signals.deliver('SIGTERM')
    signals.deliver('SIGTERM')
    if (isRemovingProfile) pending.resolve(undefined)
    else pending.reject(Object.assign(new Error('Absent'), { code: 'ENOENT' }))

    expect(await result).toBe(1)
    expect(fixture.remove).toHaveBeenCalledOnce()
    expect(fixture.inspect).toHaveBeenCalledOnce()
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(-424242, 0)
    expect(console.log).toHaveBeenCalledExactlyOnceWith('Capture fixture cleanup PASS')
    expect(signals.unhandled()).toBe(0)
    expect(signals.count()).toBe(0)
  }
)
