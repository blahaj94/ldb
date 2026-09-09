import { runInNewContext } from 'node:vm'
import { build } from 'vite'
import { resolveConfig } from 'electron-vite'
import { expect, it, vi } from 'vitest'

it.each(['electron.vite.config.ts', 'scripts/auth-capture-fixture.config.ts'])(
  '%s의 실제 preload 산출물은 외부 package require 없이 feature API를 노출한다',
  async (configFile) => {
    const resolved = await resolveConfig({ configFile, logLevel: 'silent' }, 'build', 'production')
    const preload = resolved.config?.preload
    expect(preload).toBeDefined()
    const output = await build({
      ...preload,
      logLevel: 'silent',
      build: { ...preload!.build, write: false }
    })
    const isOutputArray = Array.isArray(output)
    const bundles = isOutputArray ? output : [output]
    const chunks: string[] = []
    for (const bundle of bundles) {
      const hasOutput = 'output' in bundle
      if (!hasOutput) {
        throw new Error('Expected completed preload build')
      }
      for (const item of bundle.output) {
        const isChunk = item.type === 'chunk'
        if (isChunk) {
          chunks.push(item.code)
        }
      }
    }
    expect(chunks).toHaveLength(1)
    const expose = vi.fn()
    // Native sandbox 전체 대신 이 preload가 필요로 하는 require 경계와 실행을 검사한다.
    const requireModule = (name: string): unknown => {
      const isElectron = name === 'electron'
      if (!isElectron) {
        throw new Error(`Sandbox preload cannot require ${name}`)
      }
      return {
        contextBridge: { exposeInMainWorld: expose },
        ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
      }
    }
    expect(() => runInNewContext(chunks[0], { require: requireModule, exports: {} })).not.toThrow()
    expect(expose.mock.calls.map(([name]) => name)).toEqual(['api', 'auth', 'search'])
  }
)
